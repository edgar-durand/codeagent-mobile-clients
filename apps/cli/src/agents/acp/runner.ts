/**
 * Top-level orchestrator for an ACP-backed session.
 *
 * Equivalent role to {@link AgentService} + {@link
 * StreamingEmitterService} in the legacy PTY pipeline: spawn the
 * agent (via {@link AcpClient}), forward events upstream (via
 * {@link AcpPublisher}), accept prompts from the mobile relay
 * ({@link CommandRelayService}).
 *
 * Phase 1 scope (kept deliberately narrow so we ship a testable
 * vertical slice quickly):
 *   - start_task → `client.prompt`
 *   - stop_task / escape_key → `client.cancel`
 *   - session/update → text / thinking / tool_use / tool_result chunks
 *   - session/request_permission → publishAwaitingAnswer; the user's
 *     reply lands as a `select_option` command via the CLI's existing
 *     SSE relay (`/api/commands/pending/stream`) and `handleCommand`
 *     resolves the pending Promise back through the SDK. No polling —
 *     the project's CLAUDE.md forbids it product-wide.
 *
 * Out of scope for Phase 1 — we route these to a "not supported in
 * ACP mode" notice rather than silently dropping:
 *   - resume_session, change_model, list_models, summarize
 *
 * File / git / preview / AI-summary handlers don't need the agent
 * runtime and continue to work because we reuse the existing
 * handler registry verbatim for those.
 */

import { randomUUID } from 'node:crypto';
import { CommandRelayService, type RemoteCommand } from '../../services/command-relay.service';
import { log } from '../../services/logger';
import { showInfo, showSuccess, showRelayNotice } from '../../ui/banner';
import { AGENT_REGISTRY, type AgentId, type AgentModel, type StreamingChunkKind } from '@codeagent/shared';
import type { RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { createOsStrategy } from '../../os';
import { createInteractiveAgentStrategy } from '../registry';
import { AcpClient } from './client';
import type { AdapterSpec } from './adapters';
import { AcpPublisher } from './publisher';
import { buildAcpPromptBlocks } from './buildAcpPromptBlocks';
import { formatPromptEchoLine } from './promptEcho';
import {
  registerTerminalHandlers,
  closeAllTerminals,
} from '../../services/terminal-ops.service';
import { mapSessionUpdate, mapPermissionRequest } from './mappers';
import { extractSelectPrompt } from './selectPromptExtractor';
import {
  handlers as legacyHandlers,
  dispatchCommand as legacyDispatchCommand,
  type HandlerContext,
} from '../../commands/start/handlers';
import type { RuntimeStrategy } from '../strategy';
import { removeSession } from '../../config';
import { FileWatcherService } from '../../services/file-watcher.service';
import { TurnFileAggregator } from '../../services/turn-files/turn-file-aggregator';

/**
 * Per-turn accumulator that bridges ACP's delta-shaped notifications
 * to the legacy `/api/commands/output` chat pipe mobile actually
 * reads (see {@link AcpPublisher.publishOutput} for the wire shape).
 *
 * Design: ONE cumulative `text` buffer per turn. The chat pipe
 * coalesces by `(sessionId, type)`, so multiple `type:'text'` events
 * with the same sessionId overwrite each other until one lands with
 * `done: true`. Per-messageId sub-buffers (the previous design) only
 * works when the adapter reuses the same messageId across deltas
 * (Claude does, Gemini doesn't) — when they differ, each "buffer"
 * emits its own text event and mobile shows only the last one
 * because of the coalescence.
 *
 * Phase 1 contract:
 *   - `agent_message_chunk` deltas → appended to the cumulative
 *     buffer, emitted as `{type:'text', content:<cumulative>, done:false}`
 *   - `agent_thought_chunk`, `tool_call`, `tool_call_update` →
 *     intentionally dropped. The chat pipe only renders `type:'text'`;
 *     dedicated thinking + tool-call bubbles live on the Epic C
 *     streaming-chunk feed which Phase 2 wires up separately.
 *   - `closeAll()` always emits one final `{type:'text', content:<final>,
 *     done:true}` — even when the turn produced no text (Claude
 *     responded with tool calls only) — so mobile reliably flips out
 *     of "Thinking…".
 */
/**
 * Pending interactive question state. Two shapes — one per source —
 * tracked by {@link StreamingState} so the SSE-driven `select_option`
 * relay command can resolve whichever is active without ambiguity.
 *
 * `kind: 'permission'` — the SDK called `onRequestPermission` and is
 * waiting on the returned Promise. `select_option` resolves it with
 * the matching `optionId`; the SDK then ships the response back to
 * the adapter over JSON-RPC.
 *
 * `kind: 'free-form'` — the agent emitted text with numbered options
 * (no `session/request_permission`); the server-side parser turned
 * those into a select_prompt block. `select_option` translates the
 * picked index to the option text and re-prompts the adapter with it
 * as a new turn.
 */
type PendingInteractive =
  | {
      kind: 'permission';
      questionId: string;
      /** Ordered labels — `select_option {index}` looks the label up here. */
      labels: string[];
      optionIdByLabel: Record<string, string>;
      resolve: (response: RequestPermissionResponse) => void;
      /** Auto-reject after this ms; matches the upstream Redis TTL. */
      timeoutTimer: NodeJS.Timeout;
    }
  | {
      kind: 'free-form';
      /** Ordered option texts — `select_option {index}` indexes here
       *  and sends the picked text as the next prompt. */
      options: string[];
    };

class StreamingState {
  private text = '';
  private pending: PendingInteractive | null = null;
  /**
   * Per-chunkId cumulative buffers for the Epic C streaming-chunk
   * feed. The chat-output pipe (`publishOutput`) coalesces by
   * `(sessionId, type)` and is text-only; this feed coalesces by
   * `(sessionId, chunkId)` and carries thinking + tool_use +
   * tool_result kinds for SessionDetailScreen's richer rendering.
   *
   * Closed out with `isFinal: true` in {@link closeAll} /
   * {@link closeTurnWithInteractiveDetection} so mobile knows the
   * chunk is done streaming.
   */
  private readonly streamingChunks = new Map<
    string,
    { kind: StreamingChunkKind; content: string }
  >();

  constructor(private readonly publisher: AcpPublisher) {}

  /**
   * Register a permission Promise. The Promise stays pending until
   * `resolveSelection(index)` is called from the relay handler, OR
   * the safety timer fires after PERMISSION_TIMEOUT_MS and we
   * default-reject. Caller is the SDK's `onRequestPermission`.
   */
  registerPermission(args: {
    questionId: string;
    labels: string[];
    optionIdByLabel: Record<string, string>;
  }): Promise<RequestPermissionResponse> {
    return new Promise<RequestPermissionResponse>((resolve) => {
      const timeoutTimer = setTimeout(() => {
        if (this.pending?.kind === 'permission' && this.pending.questionId === args.questionId) {
          log.warn(
            'acpRunner',
            `permission ${args.questionId.slice(0, 8)} TTL expired — auto-cancel`,
          );
          this.pending = null;
          resolve({ outcome: { outcome: 'cancelled' } });
        }
      }, PERMISSION_TIMEOUT_MS);
      this.pending = {
        kind: 'permission',
        questionId: args.questionId,
        labels: args.labels,
        optionIdByLabel: args.optionIdByLabel,
        resolve,
        timeoutTimer,
      };
    });
  }

  /**
   * Stash the option texts the server-side select_prompt parser
   * surfaced for this turn. Cleared on `beginTurn()` (next turn) or
   * `resolveSelection()` (user picked).
   */
  registerFreeformOptions(options: string[]): void {
    this.pending = { kind: 'free-form', options };
  }

  /**
   * Apply a `select_option` command (delivered via the CLI's SSE
   * relay) to whatever pending question is active. Returns the
   * routing instruction the runner uses to drive the next ACP RPC:
   *
   *   - 'resolved' — permission Promise resolved; SDK is unblocked
   *     and the runner just acks the relay command.
   *   - 'reprompt' — free-form selection; the runner must call
   *     `client.prompt(text)` with the returned text to send the
   *     user's pick to the adapter as a new turn.
   *   - 'none' — nothing pending; the runner acks the command as
   *     failed so mobile shows a stale-question affordance.
   */
  resolveSelection(index: number): { kind: 'resolved' } | { kind: 'reprompt'; text: string } | { kind: 'none' } {
    if (!this.pending) return { kind: 'none' };
    if (this.pending.kind === 'permission') {
      const label = this.pending.labels[index];
      const optionId = label ? this.pending.optionIdByLabel[label] : undefined;
      clearTimeout(this.pending.timeoutTimer);
      const resolve = this.pending.resolve;
      this.pending = null;
      if (!optionId) {
        // Index out of range — the labels list on mobile drifted out
        // of sync with what we registered (very unlikely but cheaper
        // to handle than to assume).
        log.warn('acpRunner', `select_option index=${index} out of bounds — cancel`);
        resolve({ outcome: { outcome: 'cancelled' } });
        return { kind: 'resolved' };
      }
      resolve({ outcome: { outcome: 'selected', optionId } });
      return { kind: 'resolved' };
    }
    // Free-form path
    const text = this.pending.options[index];
    this.pending = null;
    if (!text) {
      log.warn('acpRunner', `select_option index=${index} out of bounds (free-form) — drop`);
      return { kind: 'none' };
    }
    return { kind: 'reprompt', text };
  }

  /**
   * Boundary events emitted at the start of every turn so mobile
   * wipes the previous reply and shows "Agent is typing…". Mirrors
   * the legacy `outputSvc.newTurn()`.
   */
  /**
   * Returns the cumulative agent reply text for the in-progress
   * turn. Lets the runner snapshot the text BEFORE `closeAll` /
   * `closeTurnWithInteractiveDetection` reset the buffer — needed
   * by {@link AcpHistory.appendAgentReply} so the persisted
   * conversation history carries the same reply mobile rendered.
   */
  getCurrentText(): string {
    return this.text;
  }

  async beginTurn(): Promise<void> {
    this.text = '';
    this.streamingChunks.clear();
    // Any leftover pending interactive question from a previous turn
    // is now stale — a fresh prompt supersedes it. Clear timers so we
    // don't auto-cancel a question that no longer exists.
    if (this.pending?.kind === 'permission') {
      clearTimeout(this.pending.timeoutTimer);
    }
    this.pending = null;
    await this.publisher.publishOutput({ type: 'clear' });
    await this.publisher.publishOutput({ type: 'new_turn', done: false });
  }

  append(delta: { chunkId: string; kind: StreamingChunkKind; delta: string }): void {
    // 1) Chat pipe (legacy `/api/commands/output`) — text only, single
    //    cumulative buffer per turn. Drives the main chat bubble.
    if (delta.kind === 'text') {
      this.text += delta.delta;
      void this.publisher.publishOutput({ type: 'text', content: this.text, done: false });
    }
    // 2) Epic C streaming-chunk feed (`/api/sessions/:id/streaming-chunk`)
    //    — all four kinds (text, thinking, tool_use, tool_result),
    //    cumulative per chunkId. Drives SessionDetailScreen's rich
    //    THINKING / tool-pill / tool-result bubbles. Both feeds run
    //    in parallel so the redesigned mobile surface stays in sync
    //    with the legacy chat surface.
    const existing = this.streamingChunks.get(delta.chunkId);
    const cumulativeContent = (existing?.content ?? '') + delta.delta;
    if (existing && existing.kind !== delta.kind) {
      log.warn(
        'acpRunner',
        `streaming-chunk kind flip chunkId=${delta.chunkId.slice(0, 8)} from=${existing.kind} to=${delta.kind}`,
      );
    }
    this.streamingChunks.set(delta.chunkId, { kind: delta.kind, content: cumulativeContent });
    void this.publisher.publishStreamingChunk({
      chunkId: delta.chunkId,
      kind: delta.kind,
      content: cumulativeContent,
      isFinal: false,
    });
  }

  /**
   * Flip the chat out of "Thinking…" with one final cumulative
   * `done: true`. Idempotent — safe to call from happy + error +
   * adapter-exit paths.
   *
   * Does NOT attempt select_prompt extraction — use {@link
   * closeTurnWithInteractiveDetection} for happy-path turn closure.
   * Error paths (cancel, adapter exit, half-streamed reply) call
   * THIS one because a torn-off text might match the heuristics
   * spuriously and strand the runner with a free-form pending state
   * the user can't see / answer.
   */
  async closeAll(): Promise<void> {
    const finalText = this.text;
    this.text = '';
    await Promise.all([
      this.publisher.publishOutput({ type: 'text', content: finalText, done: true }),
      this.flushStreamingChunks(),
    ]);
  }

  /**
   * Re-emit every open streaming-chunk buffer with `isFinal: true`
   * so SessionDetailScreen's bubbles flip out of "still streaming"
   * state. Idempotent — clears the map after, so a second call is a
   * no-op (matters because `closeAll` runs from several lifecycle
   * paths: happy turn-end, error catch, adapter exit).
   */
  private async flushStreamingChunks(): Promise<void> {
    if (this.streamingChunks.size === 0) return;
    const open = Array.from(this.streamingChunks.entries());
    this.streamingChunks.clear();
    await Promise.all(
      open.map(([chunkId, { kind, content }]) =>
        this.publisher.publishStreamingChunk({
          chunkId,
          kind,
          content,
          isFinal: true,
        }),
      ),
    );
  }

  /**
   * Close a successfully completed turn. Same as {@link closeAll}
   * but additionally checks whether the final cumulative text ended
   * with a "question + numbered options" pattern an ACP agent
   * commonly emits when it wants user input (Gemini's typical
   * "¿continuar?\n1. sí\n2. no" shape). When detected:
   *
   *   1. The text BEFORE the options ships as a normal text
   *      `done:true` chunk so the user sees the agent's
   *      explanation / reasoning above the buttons.
   *   2. A `type:'select_prompt'` chunk follows with the question +
   *      options — mobile renders this as tappable buttons (same
   *      legacy chunk shape Claude PTY agents already emit).
   *   3. The runner's pending state is set to `free-form` with the
   *      option texts so the matching `select_option` relay command
   *      can map index → text and re-prompt the adapter.
   *
   * When NOT detected, behaves identically to {@link closeAll} (one
   * text done:true chunk with the full cumulative).
   */
  async closeTurnWithInteractiveDetection(): Promise<void> {
    const finalText = this.text;
    this.text = '';
    // Streaming-chunk feed always flushes regardless of interactive
    // detection — those bubbles live in SessionDetailScreen on their
    // own coalescence key (chunkId) independent of the chat pipe.
    const flushSc = this.flushStreamingChunks();
    const extracted = extractSelectPrompt(finalText);
    if (!extracted) {
      await Promise.all([
        this.publisher.publishOutput({ type: 'text', content: finalText, done: true }),
        flushSc,
      ]);
      return;
    }
    log.info(
      'acpRunner',
      `select_prompt extracted question="${(extracted.question ?? '').slice(0, 60)}" options=${extracted.options.length}`,
    );
    if (extracted.textBefore.length > 0) {
      await this.publisher.publishOutput({
        type: 'text',
        content: extracted.textBefore,
        done: true,
      });
    }
    // Register pending so the matching select_option relay command
    // can resolve via reprompt to the picked text.
    this.pending = { kind: 'free-form', options: extracted.options };
    await this.publisher.publishOutput({
      type: 'select_prompt',
      content: extracted.question ?? 'Pick an option',
      options: extracted.options,
      // Mobile's renderer accepts descriptions in parallel with the
      // options array. ACP doesn't surface per-option descriptions,
      // so we ship empty strings — the renderer falls back to the
      // option text as the button label.
      optionDescriptions: extracted.options.map(() => ''),
      currentIndex: 0,
      done: true,
    });
    // Wait for the streaming-chunk feed flush we started above so
    // the turn ends with all bubbles finalised across both pipes.
    await flushSc;
  }
}

export interface AcpRunnerOptions {
  agent: AgentId;
  /** The paired-session id (the row in the backend). */
  sessionId: string;
  pluginId: string;
  /** Per-pairing secret used as `X-Plugin-Auth-Token`. Required —
   *  the publisher endpoints are guarded by PluginAuthGuard. */
  pluginAuthToken: string;
  /** Adapter spec resolved from {@link getAcpAdapter}. */
  adapter: AdapterSpec;
  /** Working directory for the ACP session — becomes the primary
   *  ACP root the agent operates over. */
  cwd: string;
}

/** Auto-cancel a permission Promise after this ms. Matches the
 *  upstream Redis TTL on the awaiting-answer record so the SDK
 *  never blocks past the point where mobile could still answer. */
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Accumulator for the conversation history mobile expects when the
 * user opens a past conversation from the RECENT sheet.
 *
 * Legacy PTY agents parse `~/.claude/projects/<cwd>/<sessionId>.jsonl`
 * and push that to `/api/sessions/conversation` via `HistoryService`.
 * ACP agents have no on-disk transcript — every turn arrives over
 * JSON-RPC stdio — so we materialise an equivalent here: append every
 * prompt the user sends + every agent reply we close out, then push
 * the cumulative list at turn boundaries.
 *
 * `summary` is the first user prompt (truncated to 120 chars) — same
 * shape the legacy JSONL parser uses to derive the row label on
 * mobile's RECENT list. `acpSessionId` is the id the ACP adapter
 * minted on `newSession`; we mirror it as the `ClaudeSession.id`
 * so mobile's resume button has a stable key per conversation.
 */
class AcpHistory {
  private readonly messages: Array<{
    id: string;
    role: 'user' | 'agent';
    text: string;
    timestamp: number;
  }> = [];
  private summary: string | null = null;

  constructor(
    private readonly publisher: AcpPublisher,
    private readonly opts: { agent: AgentId; acpSessionId: string },
  ) {}

  appendUserPrompt(text: string): void {
    if (this.summary === null) {
      // Trim newlines/whitespace and cap at 120 chars so the RECENT
      // row's one-line summary doesn't overflow on mobile.
      const trimmed = text.trim().replace(/\s+/g, ' ');
      this.summary = trimmed.length > 120 ? trimmed.slice(0, 117) + '…' : trimmed;
    }
    this.messages.push({
      id: randomUUID(),
      role: 'user',
      text,
      timestamp: Date.now(),
    });
  }

  appendAgentReply(text: string): void {
    if (text.length === 0) return;
    this.messages.push({
      id: randomUUID(),
      role: 'agent',
      text,
      timestamp: Date.now(),
    });
  }

  /**
   * Push both the session list (RECENT entry) and the cumulative
   * conversation to the backend. Fire-and-forget — failures land in
   * the publisher's trace log; the chat stream keeps working.
   *
   * Skipped when no prompt has fired yet (no summary derived) so a
   * just-paired-but-not-used session doesn't spam an empty RECENT
   * row on mobile.
   */
  async flush(): Promise<void> {
    if (this.summary === null || this.messages.length === 0) return;
    const timestamp = Date.now();
    await Promise.all([
      this.publisher.pushSessionList({
        agentId: this.opts.agent,
        sessions: [
          {
            id: this.opts.acpSessionId,
            summary: this.summary,
            timestamp,
          },
        ],
      }),
      this.publisher.pushConversation({
        agentId: this.opts.agent,
        sessionId: this.opts.acpSessionId,
        messages: this.messages,
      }),
    ]);
  }
}

export async function runAcpSession(opts: AcpRunnerOptions): Promise<void> {
  const publisher = new AcpPublisher({
    sessionId: opts.sessionId,
    pluginId: opts.pluginId,
    pluginAuthToken: opts.pluginAuthToken,
  });
  const streaming = new StreamingState(publisher);

  // IDE-integrated terminal: PTY data + exit events ride the same
  // /api/commands/output channel as chat. Without these handlers the
  // shell starts (terminal_open succeeds) but stdin/stdout never reach
  // the mobile, so the panel sits on "running" forever.
  registerTerminalHandlers({
    onData: ({ sessionId, data }) => {
      void publisher.publishOutput({
        type: 'terminal_data',
        terminalSessionId: sessionId,
        data,
        done: false,
      });
    },
    onExit: ({ sessionId, exitCode }) => {
      void publisher.publishOutput({
        type: 'terminal_exit',
        terminalSessionId: sessionId,
        exitCode,
        done: true,
      });
    },
  });

  // Counter so the log isn't drowned by every text-delta variant —
  // we surface the variant kind + a count to confirm the SDK is
  // delivering notifications without spamming a line per chunk.
  let updateCount = 0;
  const client = new AcpClient({
    adapter: opts.adapter,
    cwd: opts.cwd,
    onSessionUpdate: (notification) => {
      updateCount += 1;
      const variant = (notification.update as { sessionUpdate?: string })?.sessionUpdate ?? 'unknown';
      const deltas = mapSessionUpdate(notification);
      // Info-level so it appears with CODEAM_DEBUG=1 (the canonical
      // smoke-test invocation) without needing trace. Includes a
      // post-map delta count so we can tell "SDK delivered the
      // notification but my mapper ignored it" apart from "SDK
      // never delivered anything" — those are different bugs.
      // Preview first 120 chars of each delta (text + dropped
       // kinds) so we can spot "agent emitted something but we
       // dropped it silently" bugs in smoke tests without raw stdio
       // tracing. Tool-use info is especially load-bearing — if
       // Gemini ever asks the user something via a custom tool call
       // instead of session/request_permission, we'd miss the
       // interactive prompt without this breadcrumb.
      const previews = deltas
        .map((d) => `${d.kind}:"${d.delta.slice(0, 120).replace(/\n/g, '\\n')}"`)
        .join(' | ');
      // Also peek at the raw tool_call payload — kind alone isn't
      // enough when the bug is "we drop the tool that would have
      // shown a prompt"; we want the title / kind enum so we know
      // WHICH tool the agent invoked.
      let toolMeta = '';
      if (variant === 'tool_call' || variant === 'tool_call_update') {
        const u = notification.update as {
          toolCallId?: string;
          title?: string;
          kind?: string;
          status?: string;
        };
        toolMeta = ` tool={id=${u.toolCallId?.slice(0, 8) ?? '?'} title="${(u.title ?? '').slice(0, 60)}" kind=${u.kind ?? '?'} status=${u.status ?? '?'}}`;
      }
      log.info(
        'acpRunner',
        `update #${updateCount} variant=${variant} mappedDeltas=${deltas.length}${previews ? ` ${previews}` : ''}${toolMeta}`,
      );
      for (const delta of deltas) {
        // append() POSTs cumulative content with isFinal:false; the
        // matching isFinal:true POST happens in closeAll() after
        // client.prompt() resolves (in start_task's try block).
        streaming.append(delta);
      }
    },
    onRequestPermission: async (request) => {
      const { event, optionIdByLabel } = mapPermissionRequest(request);
      await publisher.publishAwaitingAnswer(event);
      // Event-driven: register a Promise resolver in streaming
      // state. When mobile responds, the backend pushes a
      // `select_option` command via the CLI's existing SSE relay
      // (`/api/commands/pending/stream`); the `handleCommand` switch
      // routes it back here through `streaming.resolveSelection()`.
      // No polling.
      return streaming.registerPermission({
        questionId: event.questionId,
        labels: event.options ?? [],
        optionIdByLabel,
      });
    },
    onStderr: (_line) => {
      // No-op here — AcpClient.start() already mirrors every stderr
      // line to `log.info('acpAdapter', …)` so it's visible during
      // CODEAM_DEBUG=1 smoke tests. Keeping the option for future
      // per-line filtering / capture.
    },
    onUnexpectedExit: (code, signal) => {
      log.warn('acpRunner', `adapter died code=${code} signal=${signal}; shutting down session`);
      // closeAll() flushes any half-streamed text with done:true so
      // mobile flips out of "Thinking…" instead of leaving the
      // partial reply hanging forever. Followed by a terminal error
      // message so the user knows WHY the session died.
      void streaming.closeAll().then(() =>
        publisher.publishOutput({
          type: 'text',
          content: `Agent adapter exited unexpectedly (code=${code ?? 'null'} signal=${signal ?? 'null'}).`,
          done: true,
        }),
      );
      process.exit(1);
    },
  });

  showInfo(`Starting ${opts.agent} via ACP adapter (${opts.adapter.requiresAgentBinary})…`);
  const {
    sessionId: acpSessionId,
    initialize,
    model: handshakeModel,
    tier: handshakeTier,
  } = await client.start();
  log.trace(
    'acpRunner',
    `adapter handshake ok protocolVersion=${initialize.protocolVersion} sessionId=${acpSessionId.slice(0, 8)}`,
  );
  showSuccess(`${opts.agent} online (ACP) — awaiting prompts from mobile.`);
  showRelayNotice();

  // Synthesize a welcome banner so mobile renders the branded card
  // (agent logo + title + subtitle + path) the legacy PTY path
  // shipped from `parseStartupBanner` on Claude's ASCII art. ACP
  // runs the agent headlessly so there's no TUI banner to parse —
  // we build the same wire shape from handshake data. Without this,
  // mobile's chat surface stays empty until the first prompt and
  // users wonder if the pairing actually worked.
  void publisher.publishOutput({
    type: 'agent_banner',
    agentId: opts.agent,
    // Match the legacy "Welcome back!" copy the Claude PTY banner
    // detector used as title fallback — keeps the chat surface
    // visually identical to the PTY path on first connect.
    title: 'Welcome back!',
    // Subtitle = "<display name> · <model>" when we know the model
    // (codex-acp returns `currentModelId` on newSession; claude /
    // gemini adapters omit it). Falls back to `<display name>`
    // alone so the card never renders with a dangling separator.
    subtitle: buildBannerSubtitle(opts.agent, acpSessionId, handshakeModel, handshakeTier),
    // The cwd — same field the legacy banner pulled from Claude's
    // footer line under the ASCII art.
    path: opts.cwd,
    done: true,
  });

  // Model catalog comes from the registered RuntimeStrategy — same
  // list mobile gets in the legacy PTY path so the model-picker UI
  // stays consistent even when ACP is on.
  const runtime = createInteractiveAgentStrategy(opts.agent, createOsStrategy());
  const models = await runtime.listModels();

  // Conversation history accumulator — pushes session list +
  // messages to the backend after each turn so mobile's RECENT
  // sheet renders past conversations even though ACP has no on-disk
  // JSONL the legacy HistoryService can scan.
  const history = new AcpHistory(publisher, { agent: opts.agent, acpSessionId });

  // File-change tracking — same FileWatcherService + TurnFileAggregator
  // the legacy PTY path uses. The watcher tails chokidar over `cwd`
  // and posts file_change records as the agent's tool calls land on
  // disk; the aggregator runs `git status` + `git diff --numstat`
  // once at the end of every turn and batch-posts the resulting hunk
  // changeset to the backend so mobile's PENDING REVIEW counter +
  // the Files rail / drawer light up.
  //
  // Both modules are agent-agnostic — they watch the filesystem and
  // ask git for diffs, no PTY hooks — so they wire up identically
  // for ACP as for PTY mode.
  const turnFiles = new TurnFileAggregator({
    workingDir: opts.cwd,
    sessionId: opts.sessionId,
    pluginId: opts.pluginId,
    pluginAuthToken: opts.pluginAuthToken,
    agentId: opts.agent,
  });
  // Debounced repo-dirty → flushTurn hook. In legacy PTY mode every
  // user-visible turn ended with `flushTurn()` and that was the
  // only way hunks landed. ACP sessions edit files via tool calls
  // INSIDE a turn (covered already) AND also when external clients
  // (the user's other Claude Code, a separate IDE, `gh pr checkout`)
  // touch the working tree while the codeam pair is idle. The
  // legacy reasoning ("we'll catch it on the next turn flush") falls
  // apart on ACP where the user may not send a prompt for hours.
  //
  // Debounce window matches the cross-file coalesce inside
  // FileWatcherService — long enough to let a multi-file save burst
  // settle, short enough that mobile sees hunks within ~3 s of the
  // edit. fileWatcher's onRepoDirty fires per file change so a 2 s
  // quiet-period gates the spawn-heavy git diff to one run per burst.
  const REPO_DIRTY_FLUSH_DEBOUNCE_MS = 2_000;
  let repoDirtyTimer: NodeJS.Timeout | null = null;
  const fileWatcher = new FileWatcherService({
    workingDir: opts.cwd,
    sessionId: opts.sessionId,
    pluginId: opts.pluginId,
    pluginAuthToken: opts.pluginAuthToken,
    onRepoDirty: () => {
      if (repoDirtyTimer) clearTimeout(repoDirtyTimer);
      repoDirtyTimer = setTimeout(() => {
        repoDirtyTimer = null;
        log.info('acpRunner', 'onRepoDirty debounce fired — running flushTurn');
        turnFiles.flushTurn().catch((err) => {
          log.warn('acpRunner', `flushTurn from onRepoDirty failed: ${describeError(err)}`);
        });
      }, REPO_DIRTY_FLUSH_DEBOUNCE_MS);
    },
  });
  fileWatcher
    .start()
    .then(() => {
      log.info(
        'acpRunner',
        `fileWatcher started — watching cwd=${opts.cwd} for file changes (debounce ${REPO_DIRTY_FLUSH_DEBOUNCE_MS}ms before flushTurn)`,
      );
    })
    .catch((err) => {
      log.warn('acpRunner', `fileWatcher.start failed: ${describeError(err)}`);
    });

  // Command relay — listens for prompts from mobile / web and
  // forwards them as ACP `session/prompt`. Every command branch MUST
  // call `relay.sendResult(...)` even on no-op / not-supported
  // paths; otherwise mobile retries the same command every ~20 s
  // (the dashboard polls `get_conversation` on a loop to refresh
  // the chat surface) and the relay log drowns in duplicates.
  const relay = new CommandRelayService(
    opts.pluginId,
    async (cmd) => {
      await handleCommand(
        cmd,
        client,
        relay,
        acpSessionId,
        models,
        streaming,
        opts,
        history,
        initialize.agentCapabilities,
        turnFiles,
      );
    },
    { id: opts.agent, name: opts.agent, displayName: opts.agent } as never,
  );
  relay.start();

  const shutdown = async (signal: NodeJS.Signals) => {
    showInfo(`Shutting down ACP session (${signal})…`);
    relay.stop();
    void fileWatcher.stop();
    turnFiles.stop();
    closeAllTerminals();
    await client.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGHUP', () => void shutdown('SIGHUP'));

  // Block forever — the relay runs in the background; lifecycle
  // hooks above tear everything down on exit.
  await new Promise<void>(() => {
    /* never resolves */
  });
}

/**
 * Map a relay command to the ACP equivalent.
 *
 * Every branch MUST call `relay.sendResult(cmd.id, status, result)`
 * exactly once. Without an ack the backend keeps the command in
 * "pending" and mobile's auto-refresh loops (notably
 * `get_conversation` every ~20 s) retry forever — manifests as the
 * mobile chat sitting empty while the CLI looks like it's hung.
 */
async function handleCommand(
  cmd: RemoteCommand,
  client: AcpClient,
  relay: CommandRelayService,
  acpSessionId: string,
  models: AgentModel[],
  streaming: StreamingState,
  opts: AcpRunnerOptions,
  history: AcpHistory,
  agentCaps: { loadSession?: boolean } | undefined,
  turnFiles: TurnFileAggregator,
): Promise<void> {
  switch (cmd.type) {
    case 'start_task': {
      const payload = cmd.payload as
        | {
            prompt?: string;
            files?: Array<{ filename: string; base64?: string; mimeType?: string }>;
          }
        | undefined;
      const blocks = buildAcpPromptBlocks(payload ?? {});
      if (blocks.length === 0) {
        log.warn('acpRunner', 'start_task with empty prompt + no attachments; ignoring');
        await relay.sendResult(cmd.id, 'failed', { error: 'empty prompt' });
        return;
      }
      const promptText = blocks
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const imageCount = blocks.filter((b) => b.type === 'image').length;
      log.info(
        'acpRunner',
        `start_task → forwarding textChars=${promptText.length} imageBlocks=${imageCount} id=${cmd.id.slice(0, 8)}`,
      );
      // Echo to the terminal so whoever is watching the local CLI
      // window sees the mobile prompt landed — under ACP the prompt
      // rides the adapter's JSON-RPC and never touches the PTY, so
      // the legacy "prompt appears in the terminal" signal is
      // otherwise lost (QA Android #287). `showInfo` writes through
      // the same banner-formatter the rest of the CLI uses; level-
      // gated logger emits stay structured for the debug file.
      const echoLine = formatPromptEchoLine(payload ?? {});
      if (echoLine.length > 0) {
        showInfo(echoLine);
      }
      // Mirror the legacy `outputSvc.newTurn()` boundary: clear the
      // previous reply on mobile + show "Agent is typing…". Without
      // this, mobile keeps showing the previous turn's bubble until
      // the first streaming text overwrites it, which races visibly.
      await streaming.beginTurn();
      history.appendUserPrompt(promptText);
      try {
        const reply = await client.prompt(blocks);
        // Close with interactive-detection so a trailing
        // "question + numbered options" pattern in the reply gets
        // surfaced as a tappable select_prompt chunk on mobile
        // instead of staying as plain text (Gemini's typical shape
        // for "¿continuar? 1. sí 2. no").
        const finalText = streaming.getCurrentText();
        await streaming.closeTurnWithInteractiveDetection();
        history.appendAgentReply(finalText);
        void history.flush();
        // End-of-turn file changeset — agent likely edited files
        // during the turn (tool_call write_file / bash). The
        // aggregator runs git diff once and batch-posts the hunks
        // so mobile's PENDING REVIEW counter + Files rail update.
        // Fire-and-forget; the aggregator owns its own outbox.
        turnFiles.flushTurn().catch((err) => {
          log.warn('acpRunner', `turnFiles.flushTurn failed: ${describeError(err)}`);
        });
        log.info('acpRunner', `start_task ← done stopReason=${reply.stopReason ?? '?'} id=${cmd.id.slice(0, 8)}`);
        await relay.sendResult(cmd.id, 'completed', { stopReason: reply.stopReason });
      } catch (err) {
        // Error path uses the safe closeAll (no extraction) — a
        // torn-off text could match the heuristics spuriously and
        // strand the runner with an unanswerable pending question.
        await streaming.closeAll();
        log.warn('acpRunner', `prompt failed: ${describeError(err)}`);
        await relay.sendResult(cmd.id, 'failed', { error: describeError(err) });
      }
      return;
    }
    case 'stop_task':
    case 'escape_key': {
      try {
        await client.cancel();
        await streaming.closeAll();
        await relay.sendResult(cmd.id, 'completed', {});
      } catch (err) {
        log.warn('acpRunner', `cancel failed: ${describeError(err)}`);
        await relay.sendResult(cmd.id, 'failed', { error: describeError(err) });
      }
      return;
    }
    case 'get_conversation': {
      // ACP doesn't expose the agent's prior on-disk transcript the
      // way Claude's JSONL files do — every session/update from this
      // run is published over the streaming-chunk channel as it
      // arrives, and the backend already buffers + replays them via
      // its per-user SSE bus. Returning the ACP session id (not null)
      // gives mobile a non-empty `conversationId` so the chat header
      // can render a stable name and the refresh loop quiets down.
      // No conversation-history file to upload; mobile relies on the
      // streaming-chunk bus for catch-up.
      await relay.sendResult(cmd.id, 'completed', { conversationId: acpSessionId });
      return;
    }
    case 'list_models': {
      await relay.sendResult(cmd.id, 'completed', { models });
      return;
    }
    case 'set_keep_alive':
    case 'get_context': {
      // Codespace-only / not-applicable in ACP mode. Ack as completed
      // with an empty result so mobile's optional features degrade
      // silently instead of showing a permanent "loading" spinner.
      await relay.sendResult(cmd.id, 'completed', {});
      return;
    }
    case 'select_option': {
      // Event-driven answer arrival — the user tapped an option on
      // mobile's awaiting-answer sheet or select_prompt block, and
      // the backend pushed the command via the CLI's SSE relay.
      // Routes through `streaming.resolveSelection`: permission
      // questions unblock the SDK Promise; free-form selections
      // re-prompt the adapter with the picked text.
      const payload = cmd.payload as { index?: number; from?: number };
      const index = typeof payload?.index === 'number' ? payload.index : 0;
      const offset = typeof payload?.from === 'number' ? payload.from : 0;
      const absoluteIndex = index + offset;
      const result = streaming.resolveSelection(absoluteIndex);
      switch (result.kind) {
        case 'resolved':
          log.info('acpRunner', `select_option index=${absoluteIndex} → permission resolved`);
          await relay.sendResult(cmd.id, 'completed', {});
          return;
        case 'reprompt': {
          log.info(
            'acpRunner',
            `select_option index=${absoluteIndex} → reprompt chars=${result.text.length}`,
          );
          await streaming.beginTurn();
          history.appendUserPrompt(result.text);
          try {
            const reply = await client.prompt(result.text);
            // Detect chained interactive prompts (agent asks again
            // after the first answer) so multi-step flows render as
            // buttons all the way down.
            const finalText = streaming.getCurrentText();
            await streaming.closeTurnWithInteractiveDetection();
            history.appendAgentReply(finalText);
            void history.flush();
            await relay.sendResult(cmd.id, 'completed', { stopReason: reply.stopReason });
          } catch (err) {
            await streaming.closeAll();
            log.warn('acpRunner', `reprompt failed: ${describeError(err)}`);
            await relay.sendResult(cmd.id, 'failed', { error: describeError(err) });
          }
          return;
        }
        case 'none':
          log.warn(
            'acpRunner',
            `select_option index=${absoluteIndex} arrived with no pending question — likely stale`,
          );
          await relay.sendResult(cmd.id, 'failed', {
            error: 'No pending interactive question — the prompt may have expired.',
          });
          return;
      }
      return;
    }
    case 'provide_input': {
      // Free-form text answer to an open question. Same route as
      // select_option but the user typed instead of tapping a chip.
      const payload = cmd.payload as { input?: string };
      const input = payload?.input?.trim();
      if (!input) {
        await relay.sendResult(cmd.id, 'failed', { error: 'empty input' });
        return;
      }
      // No pending-state machinery here — provide_input always means
      // "send this as the next prompt to the adapter" (any pending
      // permission Promise is left to its own TTL since the user
      // chose to type rather than pick an option).
      await streaming.beginTurn();
      history.appendUserPrompt(input);
      try {
        const reply = await client.prompt(input);
        const finalText = streaming.getCurrentText();
        await streaming.closeTurnWithInteractiveDetection();
        history.appendAgentReply(finalText);
        void history.flush();
        // End-of-turn file changeset — agent likely edited files
        // during the turn (tool_call write_file / bash). The
        // aggregator runs git diff once and batch-posts the hunks
        // so mobile's PENDING REVIEW counter + Files rail update.
        // Fire-and-forget; the aggregator owns its own outbox.
        turnFiles.flushTurn().catch((err) => {
          log.warn('acpRunner', `turnFiles.flushTurn failed: ${describeError(err)}`);
        });
        await relay.sendResult(cmd.id, 'completed', { stopReason: reply.stopReason });
      } catch (err) {
        await streaming.closeAll();
        log.warn('acpRunner', `provide_input failed: ${describeError(err)}`);
        await relay.sendResult(cmd.id, 'failed', { error: describeError(err) });
      }
      return;
    }
    case 'resume_session': {
      // ACP-native equivalent of the legacy JSONL reload. Gated on
      // `agentCapabilities.loadSession` per the ACP spec; without
      // that flag the SDK rejects the RPC. Adapters that DO support
      // it (Claude, Codex) accept the prior sessionId and rehydrate
      // the conversation context so the next prompt continues where
      // the user left off.
      const payload = cmd.payload as { id?: string };
      const id = payload?.id?.trim();
      if (!id) {
        await relay.sendResult(cmd.id, 'failed', { error: 'missing session id' });
        return;
      }
      if (!agentCaps?.loadSession) {
        await relay.sendResult(cmd.id, 'failed', {
          error: `Agent "${opts.agent}" does not advertise loadSession capability.`,
        });
        return;
      }
      try {
        await client.loadSession(id);
        await relay.sendResult(cmd.id, 'completed', { sessionId: id });
      } catch (err) {
        log.warn('acpRunner', `resume_session failed: ${describeError(err)}`);
        await relay.sendResult(cmd.id, 'failed', { error: describeError(err) });
      }
      return;
    }
    case 'change_model': {
      // Non-standard ACP extension — claude-agent-acp + codex-acp
      // expose `session/set_model`; others reject. We try the raw
      // RPC; on rejection we ack `failed` with the adapter's reason
      // so mobile can surface "model picker not supported on this
      // agent".
      const payload = cmd.payload as { modelId?: string };
      const modelId = payload?.modelId?.trim();
      if (!modelId) {
        await relay.sendResult(cmd.id, 'failed', { error: 'modelId required' });
        return;
      }
      try {
        await client.setModel(modelId);
        await relay.sendResult(cmd.id, 'completed', { modelId });
      } catch (err) {
        log.warn('acpRunner', `change_model failed: ${describeError(err)}`);
        await relay.sendResult(cmd.id, 'failed', {
          error: `Model switching not supported on ${opts.agent} via ACP: ${describeError(err)}`,
        });
      }
      return;
    }
    case 'summarize': {
      // ACP has no first-class "summarize" RPC, so we forward the
      // agent's own slash command as a regular prompt. Claude
      // recognises `/compact`, Codex `/compact`, others may not —
      // adapters without the slash command emit a normal-text
      // "unknown command" reply, which is at least user-visible.
      const payload = cmd.payload as { mode?: 'normal' | 'auto' };
      const slash = payload?.mode === 'auto' ? '/compact auto' : '/compact';
      log.info('acpRunner', `summarize → forwarding "${slash}"`);
      await streaming.beginTurn();
      history.appendUserPrompt(slash);
      try {
        const reply = await client.prompt(slash);
        const finalText = streaming.getCurrentText();
        await streaming.closeTurnWithInteractiveDetection();
        history.appendAgentReply(finalText);
        void history.flush();
        // End-of-turn file changeset — agent likely edited files
        // during the turn (tool_call write_file / bash). The
        // aggregator runs git diff once and batch-posts the hunks
        // so mobile's PENDING REVIEW counter + Files rail update.
        // Fire-and-forget; the aggregator owns its own outbox.
        turnFiles.flushTurn().catch((err) => {
          log.warn('acpRunner', `turnFiles.flushTurn failed: ${describeError(err)}`);
        });
        await relay.sendResult(cmd.id, 'completed', { stopReason: reply.stopReason });
      } catch (err) {
        await streaming.closeAll();
        log.warn('acpRunner', `summarize failed: ${describeError(err)}`);
        await relay.sendResult(cmd.id, 'failed', { error: describeError(err) });
      }
      return;
    }
    case 'session_terminated':
    case 'shutdown_session': {
      // Mobile/web "Delete session" (session_terminated) or
      // "Stop session" (shutdown_session). ACP equivalent of the
      // legacy lifecycle: ack, drop the adapter cleanly, exit.
      // session_terminated also removes the pairing record from the
      // local CLI config so the next `codeam pair` starts fresh
      // (legacy did the same via removeSession on the same event).
      try {
        await relay.sendResult(cmd.id, 'completed', { ok: true });
      } catch {
        /* best-effort — process is about to exit anyway */
      }
      showInfo(
        cmd.type === 'session_terminated'
          ? 'Session was deleted from the app — exiting.'
          : 'Session stopped from the app — exiting.',
      );
      if (cmd.type === 'session_terminated') {
        try {
          removeSession(opts.sessionId);
        } catch {
          /* best-effort */
        }
      }
      relay.stop();
      closeAllTerminals();
      await client.stop();
      process.exit(0);
      return;
    }
    case 'request_preview_detect':
    case 'preview_start':
    case 'preview_stop':
    case 'save_preview_config': {
      // Preview pipeline is agent-agnostic at the architecture level
      // (detect → start dev server → tunnel → stop). Delegate to the
      // legacy handler registry rather than re-implementing in the
      // ACP runner. The handlers emit their own `preview_*` events
      // via the per-user SSE bus; we just trigger + ack.
      const runtime = createInteractiveAgentStrategy(opts.agent, createOsStrategy());
      let previewHandlerAcked = false;
      const ackingRelay = new Proxy(relay, {
        get(target, prop, receiver) {
          if (prop === 'sendResult') {
            return (
              commandId: string,
              status: string,
              result: Record<string, unknown>,
            ) => {
              if (commandId === cmd.id) previewHandlerAcked = true;
              return target.sendResult(commandId, status, result);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      const ctx = buildLegacyContextForACP(opts, ackingRelay, runtime);
      try {
        await legacyDispatchCommand(ctx, cmd);
        if (!previewHandlerAcked) {
          await relay.sendResult(cmd.id, 'completed', {});
        }
      } catch (err) {
        log.warn('acpRunner', `${cmd.type} failed: ${describeError(err)}`);
        if (!previewHandlerAcked) {
          await relay.sendResult(cmd.id, 'failed', { error: describeError(err) });
        }
      }
      return;
    }
    default:
      // Generic-delegate fallback: agent-agnostic legacy handlers
      // (file ops, git ops, terminal ops, link credentials, file
      // reviews, etc.) work fine in ACP mode because they don't
      // touch the PTY agent / outputSvc / historySvc — only the
      // filesystem + relay. Audit-confirmed via grep against
      // `start/handlers.ts:349-720` (file/git/terminal handlers).
      //
      // PTY-dependent legacy handlers (change_model, summarize,
      // request_ai_*, resume_session) are intercepted by explicit
      // cases above OR get a clean "ACP-mode" rejection here when
      // we haven't ported them yet. The handler's own try/catch on
      // the partial ctx surfaces any unexpected PTY dependency as a
      // `failed` ack on the relay instead of a silent crash.
      if (legacyHandlers[cmd.type]) {
        const runtime = createInteractiveAgentStrategy(opts.agent, createOsStrategy());
        // Wrap the relay so we can tell whether the handler ack'd
        // this command. Duplicate acks on the same id are a real bug
        // here — the backend's last-write-wins overwrites the
        // handler's body (e.g. write_file's `{ok:true}`) with `{}`,
        // and the mobile reads `{}` as "save failed".
        let handlerAcked = false;
        const ackingRelay = new Proxy(relay, {
          get(target, prop, receiver) {
            if (prop === 'sendResult') {
              return (
                commandId: string,
                status: string,
                result: Record<string, unknown>,
              ) => {
                if (commandId === cmd.id) handlerAcked = true;
                return target.sendResult(commandId, status, result);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        const legacyCtx = buildLegacyContextForACP(opts, ackingRelay, runtime);
        try {
          await legacyDispatchCommand(legacyCtx, cmd);
          // Fallback ack ONLY when the handler didn't already send
          // one. Covers fire-and-forget legacy handlers that never
          // touch the relay (rare) without clobbering the common
          // path where the handler's structured result matters.
          if (!handlerAcked) {
            await relay.sendResult(cmd.id, 'completed', {});
          }
        } catch (err) {
          log.warn('acpRunner', `legacy handler "${cmd.type}" threw: ${describeError(err)}`);
          if (!handlerAcked) {
            await relay.sendResult(cmd.id, 'failed', { error: describeError(err) });
          }
        }
        return;
      }
      log.trace('acpRunner', `command type "${cmd.type}" not supported in ACP mode`);
      await relay.sendResult(cmd.id, 'failed', {
        error: `Command "${cmd.type}" is not supported in ACP mode.`,
      });
      return;
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Build the "welcome card" subtitle line. Pulls the agent's display
 * name from {@link AGENT_REGISTRY} (always available) and folds in
 * the adapter-advertised model + service tier when the adapter
 * surfaced them on `newSession` (codex-acp today; claude-agent-acp
 * and gemini --acp omit those fields).
 *
 * Shape variants:
 *   - Model + tier:   "Codex CLI · gpt-5 · plus"
 *   - Model only:     "Codex CLI · gpt-5"
 *   - Neither:        "Claude Code · ACP · <shortSessionId>"
 *                     (session-id suffix only kicks in here so the
 *                     bubble still gives users a debug handle when
 *                     the adapter omits model metadata).
 */
function buildBannerSubtitle(
  agentId: AgentId,
  acpSessionId: string,
  model: string | undefined,
  tier: string | undefined,
): string {
  const meta = AGENT_REGISTRY[agentId];
  const displayName = meta?.displayName ?? agentId;
  if (model && tier) return `${displayName} · ${model} · ${tier}`;
  if (model) return `${displayName} · ${model}`;
  return `${displayName} · ACP · ${acpSessionId.slice(0, 8)}`;
}

/**
 * The legacy command handlers (`apps/cli/src/commands/start/handlers.ts`)
 * accept a `HandlerContext` rich enough to drive the PTY pipeline —
 * outputSvc, agent (PTY wrapper), historySvc. Most of those handlers
 * NEED that machinery; some don't.
 *
 * For ACP we want to reuse the agent-agnostic ones (preview flow, file
 * ops, git ops, terminal ops, etc.) without re-implementing them. This
 * builds a partial context that carries ONLY the fields those handlers
 * actually read; PTY-dependent fields are `null` (cast through unknown
 * to satisfy the strict typedef) and any handler that tries to dereference
 * them throws — caught by the runner's per-command try/catch and acked
 * as `failed` to the relay.
 *
 * Used today only for the preview pipeline (request_preview_detect /
 * preview_start / preview_stop / save_preview_config). Wider delegation
 * (file/git/terminal handlers) is deliberate Phase-2 work; opening that
 * flood gate now would mask handler-specific PTY assumptions that need
 * audit first.
 */
function buildLegacyContextForACP(
  opts: AcpRunnerOptions,
  relay: CommandRelayService,
  runtime: RuntimeStrategy,
): HandlerContext {
  return {
    outputSvc: null,
    agent: null,
    historySvc: null,
    runtime,
    relay,
    setKeepAlive: null,
    keepAliveCtx: null,
    pluginId: opts.pluginId,
    sessionId: opts.sessionId,
    pluginAuthToken: opts.pluginAuthToken,
  } as unknown as HandlerContext;
}
