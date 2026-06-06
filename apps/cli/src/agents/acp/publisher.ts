/**
 * HTTP publisher for the ACP runner.
 *
 * Posts to TWO backend endpoints:
 *
 *   1. **`/api/commands/output`** — the legacy chat-render pipeline
 *      mobile actually consumes for "Thinking…" → reply → done. Same
 *      pipe `ChunkEmitter` (legacy PTY path) uses; the only
 *      destination that drives the chat surface. Wire shape:
 *      `{ sessionId, pluginId, type, content?, done? }` where `type`
 *      is `'clear' | 'new_turn' | 'text' | …`. NO `chunkId`,
 *      `kind`, or `isFinal` fields — those are part of the
 *      *streaming-chunk* feed (#2 below) which targets a different
 *      mobile surface.
 *
 *   2. **`/api/sessions/:id/awaiting-answer`** — the pending-answer
 *      sheet (permission requests, list selectors). Still uses the
 *      sessions feed because that's where the mobile awaiting-answer
 *      poll listens.
 *
 * We INTENTIONALLY skipped `/api/sessions/:id/streaming-chunk` in
 * the v2.27.8 round of fixes: smoke testing proved chunks landed
 * with 2xx but never reached the chat. Reading the legacy code
 * showed the chat pipe is `/api/commands/output`; the streaming-chunk
 * feed is Epic C internal-task-state, not the chat surface.
 */

import { _transport } from '../../services/streaming/transport';
import { resolveApiBaseUrl } from '@codeagent/shared';
import type {
  AnswerResolvedEvent,
  AwaitingAnswerEvent,
} from '@codeagent/shared';
import { log } from '../../services/logger';

export interface AcpPublisherOptions {
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  /** Override the API base URL (defaults to env / prod). Used by tests. */
  apiBaseUrl?: string;
}

export class AcpPublisher {
  private readonly apiBase: string;
  private readonly headers: Record<string, string>;

  constructor(private readonly opts: AcpPublisherOptions) {
    this.apiBase = opts.apiBaseUrl ?? resolveApiBaseUrl();
    this.headers = {
      'Content-Type': 'application/json',
      'X-Codeam-Protocol-Version': '2.0.0',
      'X-Plugin-Auth-Token': opts.pluginAuthToken,
    };
  }

  /**
   * Wrap the body with `sessionId` + `pluginId` at the top level.
   * The backend's `PluginAuthGuard` reads both fields from the JSON
   * body even when `X-Plugin-Auth-Token` is set on the header.
   */
  private envelope(body: Record<string, unknown>): string {
    return JSON.stringify({
      sessionId: this.opts.sessionId,
      pluginId: this.opts.pluginId,
      ...body,
    });
  }

  /**
   * POST one event to the legacy chat-render pipeline at
   * `/api/commands/output`. Mobile reads this feed for the chat
   * surface — every "Thinking…" → reply → done bubble flows through
   * here. Accepts arbitrary body shapes (the legacy emitter is a
   * thin pipe; mobile branches on `type`):
   *
   *   { type: 'clear' }                              wipe screen
   *   { type: 'new_turn', done: false }              "Agent is typing…"
   *   { type: 'text', content: '…', done: false }    streaming delta
   *   { type: 'text', content: '…', done: true }     turn complete
   *
   * Errors are logged but never thrown — a missed chunk shouldn't
   * bring down the whole session.
   */
  async publishOutput(body: Record<string, unknown>): Promise<void> {
    const url = `${this.apiBase}/api/commands/output`;
    try {
      const { statusCode, body: resBody } = await _transport.post(
        url,
        this.headers,
        this.envelope(body),
      );
      if (statusCode < 200 || statusCode >= 300) {
        log.warn(
          'acpPublisher',
          `output type=${String(body.type)} done=${body.done === true} status=${statusCode} body=${resBody.slice(0, 200)}`,
        );
      }
    } catch (err) {
      log.warn(
        'acpPublisher',
        `output type=${String(body.type)} post failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Publish an awaiting-answer event so the mobile renders the
   * pending-prompt sheet. The CLI follows up with
   * {@link pollPendingAnswer} until the user replies (or the
   * 5 min Redis TTL expires upstream).
   */
  async publishAwaitingAnswer(event: AwaitingAnswerEvent): Promise<void> {
    const url = `${this.apiBase}/api/sessions/${encodeURIComponent(this.opts.sessionId)}/awaiting-answer`;
    try {
      const { statusCode, body } = await _transport.post(
        url,
        this.headers,
        this.envelope(event as unknown as Record<string, unknown>),
      );
      if (statusCode < 200 || statusCode >= 300) {
        log.warn('acpPublisher', `awaiting-answer status=${statusCode} body=${body.slice(0, 200)}`);
      }
    } catch (err) {
      log.trace('acpPublisher', 'awaiting-answer post failed', err);
    }
  }

  /**
   * Drain the pending-answer endpoint. Returns the resolved answer
   * when the user has replied, `null` otherwise. The caller polls
   * this on a 1.5 s cadence (same as the legacy emitter) until a
   * non-null result lands.
   */
  async pollPendingAnswer(questionId: string): Promise<AnswerResolvedEvent | null> {
    const url =
      `${this.apiBase}/api/sessions/${encodeURIComponent(this.opts.sessionId)}/pending-answer` +
      `?questionId=${encodeURIComponent(questionId)}` +
      `&pluginId=${encodeURIComponent(this.opts.pluginId)}`;
    try {
      const { statusCode, body } = await _transport.get(url, this.headers);
      if (statusCode === 204 || statusCode === 404) return null;
      if (statusCode < 200 || statusCode >= 300) {
        log.warn('acpPublisher', `pending-answer status=${statusCode} body=${body.slice(0, 200)}`);
        return null;
      }
      return parsePendingAnswerResponse(body, questionId);
    } catch (err) {
      log.trace('acpPublisher', 'pending-answer poll failed', err);
      return null;
    }
  }
}

/**
 * Parse the `GET /api/sessions/:id/pending-answer` envelope and
 * confirm the returned questionId matches the caller's. The
 * backend wraps the resource in `{ data: { … } }` (NestJS
 * standard envelope) but legacy paths sometimes return the bare
 * shape — accept both.
 *
 * Exported so the unit tests can assert envelope handling without
 * standing up an HTTP layer.
 */
export function parsePendingAnswerResponse(
  body: string,
  questionId: string,
): AnswerResolvedEvent | null {
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
    root.data && typeof root.data === 'object'
      ? (root.data as Record<string, unknown>)
      : root;
  const qid = candidate.questionId;
  const answer = candidate.answer;
  const optionIndex = candidate.optionIndex;
  if (typeof qid !== 'string' || qid !== questionId) return null;
  if (typeof answer !== 'string') return null;
  const result: AnswerResolvedEvent = { questionId: qid, answer };
  if (typeof optionIndex === 'number' && Number.isInteger(optionIndex)) {
    result.optionIndex = optionIndex;
  }
  return result;
}
