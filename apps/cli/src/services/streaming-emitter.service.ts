import { randomUUID } from 'crypto';
import type {
  AnswerResolvedEvent,
  AwaitingAnswerEvent,
  StreamingChunkEvent,
  StreamingChunkKind,
  SelectPrompt,
  ChromeStep,
} from '@codeagent/shared';
import { renderToLines } from '@codeagent/shared';
import { log } from './logger';
import { _transport } from './streaming/transport';
import type { RuntimeStrategy } from '../agents/strategy';

/**
 * Epic C — CLI streaming producer.
 *
 * Parses the active agent's PTY output into a stream of discriminated
 * chunks (`text` / `thinking` / `tool_use` / `tool_result`) and pushes
 * each one to the backend so the mobile client can render an in-flight
 * agent turn token-by-token. Simultaneously detects React Ink
 * interactive prompts and posts them to the awaiting-answer endpoint;
 * polls the backend's answer channel and types the user's reply back
 * into the spawned agent process when one arrives.
 *
 * Discrimination rules — Claude-flavoured but agent-agnostic via
 * `RuntimeStrategy`:
 *
 *   - `runtime.parseTuiChrome(line)` returning `{ tool: 'thinking' }`
 *     → `kind: 'thinking'`.
 *   - Returning any other tool step (read / edit / bash / search /
 *     other) → `kind: 'tool_use'`.
 *   - A `└ …` tree-continuation line is treated as the result body of
 *     the preceding tool call → `kind: 'tool_result'`.
 *   - Everything else (after `runtime.filterTuiOutput`) → `kind: 'text'`.
 *
 * Chunk lifecycle: contiguous lines of the same kind share one
 * `chunkId`. When the kind flips, we mark the previous chunk
 * `isFinal: true` and open a fresh UUID. The same UUID is also closed
 * on stop / dispose so the backend can release the entry.
 *
 * Throttle: we coalesce within a 50 ms window — mirrors the backend's
 * SSE-coalescing logic and keeps a hot Claude tool-loop from
 * generating one HTTP roundtrip per render-tick.
 *
 * Best-effort transport: every POST is fire-and-forget with a small
 * retry budget; we never block the agent on emission. Failures land
 * in the logger and the next tick supersedes the missed chunk.
 */

const API_BASE = process.env.CODEAM_API_URL ?? 'https://codeagent-mobile-api.vercel.app';

/** Render + classify cadence while the emitter is active. */
const TICK_MS = 50;
/** Polling cadence for the pending-answer endpoint while awaiting a reply. */
const ANSWER_POLL_MS = 1500;
/** Idle window before we treat a selector as "stable, ship it." */
const SELECTOR_STABLE_MS = 800;
/** Max retries per chunk POST (best-effort). */
const MAX_RETRIES = 1;
const RETRY_BACKOFF_MS = 200;

/**
 * The pty-write surface the emitter needs to drive answers back into
 * the agent. `AgentService` already implements both methods; we depend
 * on the narrow shape so tests can substitute a plain object without
 * standing up a fake PTY.
 */
export interface PtyInput {
  /** Type plain text followed by Enter (used for free-form prompts). */
  sendCommand(text: string): void;
  /** Drive a React Ink selector to `targetIndex` from `fromIndex`. */
  selectOption(targetIndex: number, fromIndex?: number): void;
}

export interface StreamingEmitterOptions {
  /** Paired-session id — path param on both endpoints. */
  sessionId: string;
  /** Per-pairing pluginId — required by `PluginAuthGuard`. */
  pluginId: string;
  /** Per-pairing secret — `X-Plugin-Auth-Token` value. Required. */
  pluginAuthToken: string;
  /** Agent runtime — supplies the chrome / selector / filter parsers. */
  runtime: RuntimeStrategy;
  /** PTY-input surface for piping answers back to the agent. */
  ptyInput: PtyInput;
  /** Override the API base URL (defaults to env / prod). Used by tests. */
  apiBaseUrl?: string;
}

interface ActiveChunk {
  chunkId: string;
  kind: StreamingChunkKind;
  /** Lines already-emitted as part of this chunk, joined with `\n`. */
  emittedContent: string;
  /** Lines we've classified into this chunk this turn (may grow per tick). */
  currentContent: string;
  /** Wall-clock of the last POST for this chunk — drives the 50 ms throttle. */
  lastEmitAt: number;
}

interface PendingAnswer {
  questionId: string;
  /** Selector options if the prompt was a list; undefined for free-form. */
  options?: string[];
  /**
   * 0-based highlight index at prompt-emission time. Used to compute the
   * `fromIndex` for `selectOption` so we don't always rewind to 0 (matches
   * how the existing command-relay path drives selectors today).
   */
  fromIndex?: number;
}

export class StreamingEmitterService {
  private readonly apiBase: string;
  private readonly headers: Record<string, string>;
  private rawBuffer = '';
  private active = false;
  private tickTimer: NodeJS.Timeout | null = null;
  private answerPollTimer: NodeJS.Timeout | null = null;

  /** Open chunk we're appending bytes to; cleared on kind change or stop. */
  private activeChunk: ActiveChunk | null = null;
  /** Outstanding answer we're polling the backend for. Null when idle. */
  private pendingAnswer: PendingAnswer | null = null;
  /**
   * Memoised selector signature so we don't fire `awaiting-answer` on
   * every tick while the user thinks. Cleared once an answer resolves.
   */
  private lastSelectorSignature: string | null = null;
  private selectorFirstSeenAt = 0;

  constructor(private readonly opts: StreamingEmitterOptions) {
    this.apiBase = opts.apiBaseUrl ?? API_BASE;
    this.headers = {
      'Content-Type': 'application/json',
      'X-Codeam-Protocol-Version': '2.0.0',
      'X-Plugin-Auth-Token': opts.pluginAuthToken,
    };
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  start(): void {
    if (this.active) return;
    this.active = true;
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.answerPollTimer = setInterval(() => {
      void this.pollPendingAnswer();
    }, ANSWER_POLL_MS);
    log.trace('streamingEmitter', `started session=${this.opts.sessionId.slice(0, 8)}`);
  }

  /**
   * Stop the emitter. Finalises the open chunk (if any) so the
   * backend doesn't leave a half-streamed message in the SSE
   * buffer. Idempotent.
   */
  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.answerPollTimer) {
      clearInterval(this.answerPollTimer);
      this.answerPollTimer = null;
    }
    if (this.activeChunk) {
      const finalContent = this.activeChunk.currentContent;
      const chunk = this.activeChunk;
      this.activeChunk = null;
      await this.postChunk({
        chunkId: chunk.chunkId,
        kind: chunk.kind,
        content: finalContent,
        isFinal: true,
      });
    }
    log.trace('streamingEmitter', `stopped session=${this.opts.sessionId.slice(0, 8)}`);
  }

  // ─── Input pump ────────────────────────────────────────────────────

  /**
   * Forward a chunk of raw PTY bytes into the emitter. Safe to call
   * before `start()` — bytes accumulate in the internal buffer and the
   * first tick processes the backlog.
   */
  push(raw: string): void {
    if (raw.length === 0) return;
    this.rawBuffer += raw;
  }

  // ─── Tick ──────────────────────────────────────────────────────────

  /**
   * Visible for tests. Runs one classify-and-emit pass against the
   * current PTY buffer.
   */
  /* @internal */ _tickForTest(): void {
    this.tick();
  }

  private tick(): void {
    if (!this.active) return;

    const lines = (this.opts.runtime.renderToLines ?? renderToLines)(this.rawBuffer);

    // Selector takes precedence — when the agent is mid-prompt, we
    // stop streaming chunks (the awaiting-answer event carries the
    // prompt) and wait for the user's reply.
    const selector = this.opts.runtime.detectInteractivePrompt(lines);
    if (selector) {
      this.maybeEmitAwaitingAnswer(selector);
      return;
    }
    this.lastSelectorSignature = null;
    this.selectorFirstSeenAt = 0;

    // Classify line-by-line; coalesce contiguous same-kind lines into
    // a single chunk.
    const groups = this.classifyLines(lines, this.opts.runtime);
    if (groups.length === 0) return;

    // Stream only the LAST group — the active chunk. Anything before
    // is already finalised (or, on first tick, will be finalised when
    // the kind flips later).
    const last = groups[groups.length - 1];

    if (this.activeChunk && this.activeChunk.kind === last.kind) {
      this.activeChunk.currentContent = last.content;
      this.maybeFlushActive(false);
      return;
    }

    // Kind flip — close the previous chunk if any, then open a new one
    // for `last`.
    if (this.activeChunk) {
      const closing = this.activeChunk;
      this.activeChunk = null;
      void this.postChunk({
        chunkId: closing.chunkId,
        kind: closing.kind,
        content: closing.currentContent,
        isFinal: true,
      });
    }
    this.activeChunk = {
      chunkId: randomUUID(),
      kind: last.kind,
      emittedContent: '',
      currentContent: last.content,
      lastEmitAt: 0,
    };
    this.maybeFlushActive(false);
  }

  private maybeFlushActive(force: boolean): void {
    const chunk = this.activeChunk;
    if (!chunk) return;
    const now = Date.now();
    if (!force && now - chunk.lastEmitAt < TICK_MS) return;
    if (chunk.currentContent === chunk.emittedContent) return;
    chunk.emittedContent = chunk.currentContent;
    chunk.lastEmitAt = now;
    void this.postChunk({
      chunkId: chunk.chunkId,
      kind: chunk.kind,
      content: chunk.currentContent,
      isFinal: false,
    });
  }

  // ─── Line classification ───────────────────────────────────────────

  /**
   * Walk the rendered screen lines and bucket them into kind-groups.
   *
   * Visible for tests so we can assert discrimination against fixture
   * inputs without standing up the full POST loop.
   */
  /* @internal */ _classifyForTest(lines: string[]): Array<{
    kind: StreamingChunkKind;
    content: string;
  }> {
    return this.classifyLines(lines, this.opts.runtime);
  }

  private classifyLines(
    lines: string[],
    runtime: RuntimeStrategy,
  ): Array<{ kind: StreamingChunkKind; content: string }> {
    const parseLine = runtime.parseTuiChrome?.bind(runtime);
    const groups: Array<{ kind: StreamingChunkKind; content: string }> = [];
    let current: { kind: StreamingChunkKind; lines: string[] } | null = null;
    const flush = (): void => {
      if (!current) return;
      const text = current.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      if (text.length > 0) groups.push({ kind: current.kind, content: text });
      current = null;
    };

    for (const rawLine of lines) {
      const kind = classifyLine(rawLine, parseLine, runtime);
      if (kind === null) continue; // pure chrome / spinner — drop
      if (!current || current.kind !== kind) {
        flush();
        current = { kind, lines: [rawLine] };
      } else {
        current.lines.push(rawLine);
      }
    }
    flush();
    return groups;
  }

  // ─── Awaiting-answer + answer subscription ─────────────────────────

  private maybeEmitAwaitingAnswer(selector: SelectPrompt): void {
    const signature = `${selector.question}::${selector.options.join('|')}`;
    const now = Date.now();
    if (this.lastSelectorSignature !== signature) {
      this.lastSelectorSignature = signature;
      this.selectorFirstSeenAt = now;
      return;
    }
    // Already an outstanding question for this exact prompt — don't
    // re-fire.
    if (this.pendingAnswer) return;
    if (now - this.selectorFirstSeenAt < SELECTOR_STABLE_MS) return;

    // Stable selector → emit. Selectors with multiple options carry
    // `options`; free-form `question`-only prompts (currently unused
    // by Claude but supported by the wire shape) omit it.
    const questionId = randomUUID();
    this.pendingAnswer = {
      questionId,
      options: selector.options.length > 0 ? selector.options : undefined,
      fromIndex: selector.currentIndex,
    };
    const event: AwaitingAnswerEvent = {
      questionId,
      prompt: selector.question,
      ...(selector.options.length > 0 ? { options: selector.options } : {}),
    };
    void this.postAwaitingAnswer(event);
  }

  private async pollPendingAnswer(): Promise<void> {
    if (!this.active) return;
    if (!this.pendingAnswer) return;
    const questionId = this.pendingAnswer.questionId;
    try {
      const { statusCode, body } = await _transport.get(
        `${this.apiBase}/api/sessions/${encodeURIComponent(this.opts.sessionId)}/pending-answer?questionId=${encodeURIComponent(questionId)}`,
        this.headers,
      );
      if (statusCode === 204 || statusCode === 404) {
        // No answer yet — wait for the next poll.
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        log.warn('streamingEmitter', `pending-answer status=${statusCode} body=${body.slice(0, 200)}`);
        return;
      }
      const parsed = parsePendingAnswerResponse(body);
      if (!parsed || parsed.questionId !== questionId) return;
      // Resolved — clear pending state BEFORE writing to PTY so a
      // late-arriving duplicate poll doesn't double-fire.
      const pending = this.pendingAnswer;
      this.pendingAnswer = null;
      this.lastSelectorSignature = null;
      this.selectorFirstSeenAt = 0;
      this.deliverAnswer(parsed, pending);
    } catch (err) {
      log.trace('streamingEmitter', 'pending-answer poll failed', err);
    }
  }

  private deliverAnswer(answer: AnswerResolvedEvent, pending: PendingAnswer): void {
    if (pending.options && pending.options.length > 0) {
      // Selector path: prefer the explicit index from the backend; fall
      // back to resolving the answer label against the options we
      // shipped with the prompt.
      let targetIndex = answer.optionIndex ?? -1;
      if (targetIndex < 0) {
        targetIndex = pending.options.findIndex((o) => o === answer.answer);
      }
      if (targetIndex < 0 || targetIndex >= pending.options.length) {
        log.warn(
          'streamingEmitter',
          `answer label "${answer.answer}" not found in selector options — defaulting to 0`,
        );
        targetIndex = 0;
      }
      this.opts.ptyInput.selectOption(targetIndex, pending.fromIndex ?? 0);
      return;
    }
    // Free-form prompt: type the user's text into the agent's stdin.
    this.opts.ptyInput.sendCommand(answer.answer);
  }

  // ─── POSTs ─────────────────────────────────────────────────────────

  private async postChunk(event: StreamingChunkEvent): Promise<void> {
    await this.postWithRetries(
      `${this.apiBase}/api/sessions/${encodeURIComponent(this.opts.sessionId)}/streaming-chunk`,
      event,
    );
  }

  private async postAwaitingAnswer(event: AwaitingAnswerEvent): Promise<void> {
    await this.postWithRetries(
      `${this.apiBase}/api/sessions/${encodeURIComponent(this.opts.sessionId)}/awaiting-answer`,
      event,
    );
  }

  private async postWithRetries(
    url: string,
    body: StreamingChunkEvent | AwaitingAnswerEvent,
  ): Promise<void> {
    const payload = JSON.stringify(body);
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const { statusCode, body: resBody } = await _transport.post(url, this.headers, payload);
        if (statusCode >= 200 && statusCode < 300) {
          log.trace('streamingEmitter', `post ok url=${url} status=${statusCode}`);
          return;
        }
        if (statusCode === 410 || statusCode === 404) {
          // Session is gone — stop trying for the rest of the run.
          log.warn('streamingEmitter', `session dead (status=${statusCode}) — disabling emitter`);
          this.active = false;
          if (this.tickTimer) {
            clearInterval(this.tickTimer);
            this.tickTimer = null;
          }
          if (this.answerPollTimer) {
            clearInterval(this.answerPollTimer);
            this.answerPollTimer = null;
          }
          return;
        }
        log.warn(
          'streamingEmitter',
          `post failed url=${url} status=${statusCode} attempt=${attempt + 1} body=${resBody.slice(0, 200)}`,
        );
      } catch (err) {
        log.warn('streamingEmitter', `post error url=${url} attempt=${attempt + 1}`, err);
      }
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF_MS * (attempt + 1));
      }
    }
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const TREE_CONTINUATION_RE = /^\s*└/;

/**
 * Returns the chunk-kind for a single rendered line, or `null` when
 * the line should be dropped entirely (pure chrome — spinners, dim
 * status bars, separators).
 *
 * Exported for unit tests only; not part of the public service API.
 */
export function classifyLine(
  line: string,
  parseChrome: ((line: string) => ChromeStep | null) | undefined,
  runtime: RuntimeStrategy,
): StreamingChunkKind | null {
  if (line.trim().length === 0) return null;

  // Tree continuation glyph (`└ …`) carries the body of the previous
  // tool call — bucketed as `tool_result` regardless of whether the
  // per-agent chrome parser claims it.
  if (TREE_CONTINUATION_RE.test(line)) return 'tool_result';

  const step = parseChrome?.(line) ?? null;
  if (step) {
    if (step.tool === 'thinking') return 'thinking';
    return 'tool_use';
  }

  // Not a chrome step — let the per-agent filter decide. If the line
  // survives the filter it's conversational text; if it gets stripped
  // we drop it from the stream too.
  const filtered = runtime.filterTuiOutput([line]);
  if (filtered.length === 0) return null;
  return 'text';
}

/**
 * Parse the `GET /api/sessions/:id/pending-answer` envelope. The
 * backend returns either:
 *   - `{ data: { questionId, answer, optionIndex? } }` (standard envelope)
 *   - or the bare shape when the API returns the resource directly.
 *
 * Returns `null` if the response is malformed or contains no answer.
 */
export function parsePendingAnswerResponse(body: string): AnswerResolvedEvent | null {
  if (!body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const root = parsed as Record<string, unknown>;
  const candidate =
    root.data && typeof root.data === 'object' ? (root.data as Record<string, unknown>) : root;
  const questionId = candidate.questionId;
  const answer = candidate.answer;
  const optionIndex = candidate.optionIndex;
  if (typeof questionId !== 'string' || typeof answer !== 'string') return null;
  const result: AnswerResolvedEvent = { questionId, answer };
  if (typeof optionIndex === 'number' && Number.isInteger(optionIndex)) {
    result.optionIndex = optionIndex;
  }
  return result;
}
