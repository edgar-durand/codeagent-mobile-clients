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
import { fetchCurrentPluginAuthToken } from '../../services/pairing.service';
import { log } from '../../services/logger';
import { HistoryService } from '../../services/history.service';
import { showInfo, showSuccess, showRelayNotice } from '../../ui/banner';
import { AGENT_REGISTRY, type AgentId, type AgentModel, type StreamingChunkKind } from '@codeam/shared';
import type { RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { createOsStrategy } from '../../os';
import { createInteractiveAgentStrategy } from '../registry';
import { killHeadroomProxy, writeHeadroomProxyPidfile } from '../../services/headroom/proxy-pid';
import { AcpClient, type AcpClientOptions } from './client';
import type { AdapterSpec } from './adapters';
import { AcpPublisher } from './publisher';
import type { PromptBlock } from './buildAcpPromptBlocks';
import { createBudgetRecovery, type BudgetRecovery } from './budgetRecovery';
import { createWakeCredentialProbe, localCredentialExpiryStatus } from './wakeCredentialProbe';
import { reconcileCumulative } from './reconcileDelta';
import { maybeSendOnboardingWelcome } from './onboarding';
import {
  registerTerminalHandlers,
  closeAllTerminals,
} from '../../services/terminal-ops.service';
import { mapSessionUpdate, mapPermissionRequest } from './mappers';
import { extractSelectPrompt } from './selectPromptExtractor';
import { prewarmPreviewDetection } from '../../commands/start/handlers';
import { loadCliConfig } from '../../config';
import { FileWatcherService } from '../../services/file-watcher.service';
import { TurnFileAggregator } from '../../services/turn-files/turn-file-aggregator';
import type { StartedBeads } from '../../beads';
import { withTimeout } from './withTimeout';
import {
  AUTH_FAILURE_MESSAGE,
  adapterExitMessage,
  describeError,
  looksLikeAuthFailure,
  looksLikeProviderOutage,
  startupFailureMessage,
} from './failure-messages';
import { reportCredentialInvalid } from './backend-reports';
import { agentHooks } from './agent-hooks';
import { dispatchAcpCommand, recoverFromFailedTurn } from './command-handlers';

// ─── Re-exports (Phase 3 extraction, bd codeagent-2sa) ────────────────────
// The failure-messaging contract, the best-effort backend report POSTs, and
// the per-command handlers/dispatch table were extracted VERBATIM to sibling
// modules (`failure-messages.ts`, `backend-reports.ts`, `command-handlers.ts`).
// Re-exported here so existing importers — notably the acp.*.test suites —
// keep working unchanged.
export {
  AUTH_FAILURE_MESSAGE,
  ONE_M_CREDITS_MESSAGE,
  TURN_FAILURE_MESSAGE,
  WINDOWS_CONTROL_C_EXIT,
  adapterExitMessage,
  agentStatusPage,
  budgetBubbleMessage,
  failureBubble,
  looksLikeAuthFailure,
  looksLikeProviderOutage,
  providerOutageMessage,
  replyIsAuthFailure,
  replyIsCursorUpgradeRequired,
  startupFailureMessage,
} from './failure-messages';
export { postBudgetReached, reportCredentialInvalid } from './backend-reports';
export {
  ACP_QUICK_REPLIES,
  buildLegacyContextForACP,
  cancelStuckTurn,
  dispatchAcpCommand,
  handleGetConversation,
  recoverFromFailedTurn,
  type AcpCommandContext,
  type AcpCommandHandler,
} from './command-handlers';

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

export class StreamingState {
  /**
   * Cumulative agent reply for the in-progress turn — the body of the
   * chat bubble (`/api/commands/output` text events). DERIVED from the
   * per-chunkId text buffers in {@link streamingChunks} via
   * {@link recomputeText} on every `append`, NOT accumulated with a
   * blind `+=`. That derivation is what makes the chat pipe correct for
   * adapters that send cumulative snapshots (a self-hosted MiniMax proxy
   * behind claude-agent-acp) as well as true-delta adapters (Anthropic
   * Claude): `reconcileCumulative` collapses a re-sent snapshot instead
   * of concatenating the reply with itself (the "…hoy?¡Hola!…hoy?"
   * intra-reply duplication bug).
   */
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

  /**
   * Stable chunkId that ALL `text` segments of the current turn collapse
   * onto (set to the first text chunk's id, reset each {@link beginTurn}).
   *
   * Why: `claude-agent-acp` (≥0.47) streams the reply live as
   * `agent_message_chunk` deltas under one message id, then — when its
   * own streamed-vs-consolidated dedupe misfires (the live path keys
   * `streamedTextIds` off the stream message id while consolidation
   * checks `messageIdForGrouping`, which can differ per gateway) —
   * RE-EMITS the complete assistant message as a fresh
   * `agent_message_chunk` under a DIFFERENT message id. Keying our buffer
   * off the adapter's chunkId then lands the two copies in two buckets,
   * and `recomputeText` concatenates them → the whole reply doubles
   * ("…del proyecto.¡Perfecto!…del proyecto."). Observed on BOTH real
   * Claude (codespace) and the MiniMax proxy (self-hosted) — anything
   * behind this adapter. Collapsing every text segment of a turn into one
   * reconcile buffer makes the re-emit a `reconcileCumulative` REPLACE
   * (identical snapshot) instead of an APPEND, so the reply can't double
   * no matter how many message ids the adapter spreads it across.
   */
  private turnTextChunkId: string | null = null;

  /**
   * Stable chunkId that ALL `thinking` segments of the current turn collapse
   * onto (set to the first thought chunk's id, reset each {@link beginTurn}) —
   * the thinking twin of {@link turnTextChunkId}.
   *
   * Why: `claude-agent-acp` (≥0.47) re-emits the CONSOLIDATED thought under a
   * DIFFERENT message id (the same dedupe misfire that doubles text). The
   * mapper derives the thinking chunkId from that message id
   * (`<messageId>::thought`), so the consolidated re-emit lands in a SECOND
   * `::thought` buffer, BOTH get flushed `isFinal:true`, and the mobile
   * activity card (which coalesces by chunkId) stacks the two copies → the
   * thinking doubles ("TheThe user said …briefly.The user said …briefly.").
   * Text was protected by {@link turnTextChunkId}; thinking was not. Collapsing
   * every thought segment of a turn onto one reconcile buffer makes the re-emit
   * a `reconcileCumulative` REPLACE (identical snapshot) instead of a second
   * buffer. tool_use / tool_result keep their own id within the turn (distinct
   * bubbles; the adapter does NOT re-emit a consolidated tool snapshot under a
   * fresh id, so they don't share this bug).
   */
  private turnThoughtChunkId: string | null = null;

  /**
   * Monotonic turn counter, bumped each {@link beginTurn}. Used to NAMESPACE
   * every streaming-chunk id so an id the ACP adapter REUSES across turns can't
   * collide on the mobile feed. `claude-agent-acp` emits `toolu_01` for the
   * first tool of EVERY turn (and reuses it for sequential tools), so without a
   * per-turn prefix, once turn 1's `toolu_01` chunk was flushed `isFinal:true`,
   * a later turn's `toolu_01` was treated as the already-final chunk and
   * DROPPED — thinking/tool-call chips rendered on the first turn then
   * disappeared on subsequent ones (the "tool calls stop showing after a couple
   * messages" bug). Text is unaffected (it collapses onto a per-turn-reset
   * {@link turnTextChunkId}); this protects the thinking/tool_use/tool_result
   * kinds that key purely off the adapter id.
   */
  private turnSeq = 0;

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

  async beginTurn(opts?: { clear?: boolean }): Promise<void> {
    this.text = '';
    this.streamingChunks.clear();
    this.turnTextChunkId = null;
    this.turnThoughtChunkId = null;
    // New turn → new namespace, so a reused adapter chunkId (e.g. `toolu_01`)
    // never collides with a prior turn's already-finalized chunk on the feed.
    this.turnSeq += 1;
    // Any leftover pending interactive question from a previous turn
    // is now stale — a fresh prompt supersedes it. Clear timers so we
    // don't auto-cancel a question that no longer exists.
    if (this.pending?.kind === 'permission') {
      clearTimeout(this.pending.timeoutTimer);
    }
    this.pending = null;
    // `clear` flushes the backend output buffer — the source SSE catchup
    // replays when a client opens the session. The onboarding welcome turn
    // passes { clear: false } because it runs right AFTER the agent_banner
    // card is published: clearing here wiped that card from the buffer, so
    // anyone opening the session after first-pair saw the welcome text with
    // no branded banner. It's the session's first turn, so there's nothing
    // else to clear. Real command turns keep the default (clear: true).
    if (opts?.clear !== false) {
      await this.publisher.publishOutput({ type: 'clear' });
    }
    await this.publisher.publishOutput({ type: 'new_turn', done: false });
  }

  append(delta: { chunkId: string; kind: StreamingChunkKind; delta: string }): void {
    // Reconcile the incoming segment against the chunk's accumulated
    // content with snapshot-vs-delta awareness (see reconcileCumulative):
    // a true-delta adapter (Anthropic Claude) appends, a cumulative-
    // snapshot adapter (self-hosted MiniMax-M3 proxy behind
    // claude-agent-acp) replaces — instead of `+=` doubling the reply.
    // Every `text` segment of a turn collapses onto one stable chunkId
    // (the first text chunk's), so the adapter re-emitting the full reply
    // under a second message id reconciles in place (REPLACE) instead of
    // landing in a second buffer that recomputeText would concatenate —
    // the reply-doubling bug (see turnTextChunkId). `thinking` collapses the
    // same way onto turnThoughtChunkId — the adapter re-emits the consolidated
    // thought under a 2nd message id too, so without this it lands in a 2nd
    // `::thought` buffer and the activity card doubles it (see
    // turnThoughtChunkId). tool_use / tool_result keep their own id within the
    // turn: those are distinct bubbles the adapter never re-emits consolidated.
    const baseId =
      delta.kind === 'text'
        ? (this.turnTextChunkId ??= delta.chunkId)
        : delta.kind === 'thinking'
          ? (this.turnThoughtChunkId ??= delta.chunkId)
          : delta.chunkId;
    // Prefix with the turn counter so an adapter chunkId reused across turns
    // (`toolu_01` every turn) maps to a DISTINCT feed id each turn — otherwise
    // the mobile drops it as the prior turn's already-finalized chunk and the
    // tool/thinking chips stop rendering after turn 1. Within a turn the prefix
    // is constant, so a tool_call_update still lands on its tool_call's chunk.
    const chunkId = `t${this.turnSeq}:${baseId}`;
    const existing = this.streamingChunks.get(chunkId);
    if (existing && existing.kind !== delta.kind) {
      log.warn(
        'acpRunner',
        `streaming-chunk kind flip chunkId=${chunkId.slice(0, 8)} from=${existing.kind} to=${delta.kind}`,
      );
    }
    const cumulativeContent = reconcileCumulative(existing?.content ?? '', delta.delta);
    this.streamingChunks.set(chunkId, { kind: delta.kind, content: cumulativeContent });

    // 1) Chat pipe (legacy `/api/commands/output`) — text only. The
    //    bubble body is the ordered concatenation of every text chunk's
    //    reconciled content, recomputed from the per-chunkId buffers so
    //    a snapshot re-send can never concatenate the reply with itself.
    if (delta.kind === 'text') {
      this.recomputeText();
      void this.publisher.publishOutput({ type: 'text', content: this.text, done: false });
    }
    // 2) Epic C streaming-chunk feed (`/api/sessions/:id/streaming-chunk`)
    //    — all four kinds (text, thinking, tool_use, tool_result),
    //    cumulative per chunkId. Drives SessionDetailScreen's rich
    //    THINKING / tool-pill / tool-result bubbles. Both feeds run
    //    in parallel so the redesigned mobile surface stays in sync
    //    with the legacy chat surface.
    void this.publisher.publishStreamingChunk({
      chunkId,
      kind: delta.kind,
      content: cumulativeContent,
      isFinal: false,
    });
  }

  /**
   * Rebuild the cumulative chat-bubble text from the per-chunkId text
   * buffers, in arrival order (Map preserves insertion order). Source
   * of truth for the `text` field — never accumulated incrementally, so
   * a re-sent snapshot updates its own chunk in place rather than
   * lengthening the reply.
   */
  private recomputeText(): void {
    let next = '';
    for (const { kind, content } of this.streamingChunks.values()) {
      if (kind === 'text') next += content;
    }
    this.text = next;
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
   * Close the turn but REPLACE the streamed reply with `bubble` as the
   * terminal chat frame. The chat pipe treats each `text` chunk's content as
   * the full (replacing) bubble body, so a final `done:true` carrying the
   * bubble overwrites whatever raw text streamed. Used when the agent's
   * completed-turn reply was itself an auth-failure notice
   * ({@link replyIsAuthFailure}) → swap the raw "Please run /login" for the
   * actionable re-auth bubble.
   */
  async closeWithBubble(bubble: string): Promise<void> {
    this.text = '';
    // Neutralise any open `text` streaming-chunk buffer so the raw streamed
    // reply (e.g. the agent's own "…401 Invalid authentication credentials")
    // is NOT finalised verbatim on the Epic C feed — replace its content with
    // the bubble so the chunk that flushes `isFinal:true` carries the
    // actionable message, never the raw error. thinking / tool_use /
    // tool_result chunks are left untouched (they're genuine prior activity).
    for (const [chunkId, chunk] of this.streamingChunks) {
      if (chunk.kind === 'text') {
        this.streamingChunks.set(chunkId, { kind: 'text', content: bubble });
      }
    }
    await Promise.all([
      this.publisher.publishOutput({ type: 'text', content: bubble, done: true }),
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
  async closeTurnWithInteractiveDetection(): Promise<boolean> {
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
      return false;
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
    return true;
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
  /** Accessor for the live Beads handle (watcher + adapter), provisioned
   *  by the CLI composition root (`start()`) as a separate, non-fatal
   *  concern — NOT by this runner (SRP decision D10). Returns null until
   *  provisioning resolves, or forever when beads is off (kill-switch /
   *  no bd / failed). Used only to route relayed `beads_action` commands;
   *  the runner never provisions or tears down beads. */
  getBeads?: () => StartedBeads | null;
  /**
   * AUTO mode: auto-approve every `session/request_permission` instead of
   * round-tripping to a human. Set in headless contexts (a GitHub Codespace
   * has no one at the phone to answer), so the agent never stalls a turn
   * waiting on a permission decision that will never come — the robust,
   * agent-agnostic equivalent of `claude --dangerously-skip-permissions`.
   */
  autoApprovePermissions?: boolean;
  /** Replayed raw to the gated /api/pairing/reconnect for token refresh. */
  pollSecret?: string;
}

/** Auto-cancel a permission Promise after this ms. Matches the
 *  upstream Redis TTL on the awaiting-answer record so the SDK
 *  never blocks past the point where mobile could still answer. */
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

/** One ACP permission option (subset of the SDK's PermissionOption). */
interface AcpPermissionOption {
  optionId: string;
  kind: string;
}

/**
 * AUTO-mode option picker: choose the broadest "allow" grant (allow_always,
 * else allow_once) from an ACP permission request's options, or null when the
 * agent offers no allow option (then the caller falls back to interactive).
 * Pure + exported so the auto-approve decision is unit-tested without spinning
 * up a full ACP session.
 */
export function pickAllowOption<T extends AcpPermissionOption>(options: readonly T[]): T | null {
  return (
    options.find((o) => o.kind === 'allow_always') ??
    options.find((o) => o.kind === 'allow_once') ??
    null
  );
}

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
export class AcpHistory {
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
   * Record an agent-initiated reply that has NO preceding user prompt
   * — the first-pair onboarding welcome the agent sends on its own.
   * Seeds the RECENT summary from the reply itself (so {@link flush}
   * isn't skipped for lack of a user prompt) and appends ONLY the
   * agent message: the background instruction that produced this reply
   * must never surface as a user bubble on mobile.
   */
  appendAgentInitiatedReply(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (this.summary === null) {
      const oneLine = trimmed.replace(/\s+/g, ' ');
      this.summary = oneLine.length > 120 ? oneLine.slice(0, 117) + '…' : oneLine;
    }
    this.appendAgentReply(text);
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

// The 1M-context-credits classifier lives in `oneMContextRecovery` so THAT
// module has no import back into this heavy runner graph (its test would
// otherwise drag the whole graph in — 45 s import — and starve the parallel
// real-spawn integration tests). Re-exported so `acp.failureBubble.test` can
// still import it from runner alongside the other classifiers.
export { looksLike1mContextCreditsError } from './oneMContextRecovery';
export { looksLikeBudgetExceeded } from './budgetRecovery';

/**
 * Bring the plugin ONLINE with a minimal relay and publish a clear message when
 * the agent failed to START (no session). Without this, pair-auto exited on the
 * start() throw, the command relay never began, the plugin's heartbeat never
 * fired, and mobile sat on "STILL LOADING SESSION HISTORY / offline" forever.
 *
 * The agent is dead, so the relay only: acks `get_conversation` (resolves the
 * history-load spinner) and, for any prompt/action, re-publishes the reason and
 * fails the command. The relay's long-lived SSE keeps the process alive so the
 * session stays online showing the message until the user re-links / redeploys.
 */
async function surfaceStartupFailure(opts: {
  agent: AgentId;
  pluginId: string;
  detail: string;
  recentStderr: string;
  publisher: AcpPublisher;
}): Promise<void> {
  const msg = startupFailureMessage(opts.agent, opts.detail, opts.recentStderr);
  const publish = async (): Promise<void> => {
    try {
      await opts.publisher.publishOutput({ type: 'new_turn', done: false });
      await opts.publisher.publishOutput({ type: 'text', content: msg, done: true });
    } catch {
      /* best-effort — never throw out of the failure path */
    }
  };
  await publish();
  const errRelay = new CommandRelayService(
    opts.pluginId,
    async (cmd: RemoteCommand) => {
      if (cmd.type === 'get_conversation') {
        await errRelay.sendResult(cmd.id, 'completed', {}).catch(() => undefined);
        return;
      }
      await publish();
      await errRelay
        .sendResult(cmd.id, 'failed', {
          error: `${opts.agent} is unavailable — see the message in chat.`,
        })
        .catch(() => undefined);
    },
    { id: opts.agent, name: opts.agent, displayName: opts.agent } as never,
  );
  errRelay.start();
}

/**
 * Build the env object for relaunching the Headroom proxy WITHOUT any budget cap.
 *
 * Spreads `baseEnv` (normally `process.env`), sets `HEADROOM_KOMPRESS_BACKEND`
 * to lock the ONNX backend, then **deletes** both budget env keys so the
 * relaunched proxy starts with NO cap even when the headroom_budget handler
 * had previously written those keys into `process.env` on the same process.
 *
 * Pure + exported so the "pause clears budget env" invariant is
 * unit-tested without spawning a full ACP runner or a real proxy.
 */
export function buildRelaunchProxyEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...baseEnv, HEADROOM_KOMPRESS_BACKEND: 'onnx_cpu' };
  delete env['HEADROOM_BUDGET'];
  delete env['HEADROOM_BUDGET_PERIOD'];
  return env as NodeJS.ProcessEnv;
}

/**
 * Adapter spawn env for an ACP session. Two independent knobs:
 *
 *  - `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` — the per-session 1M-context opt-out,
 *    persisted after the user chooses "Disable 1M context and continue".
 *  - `INITIAL_AGENT_MODE=agent-full-access` — Codex only, and ONLY in our
 *    autonomous execution plane (a codespace / self-hosted box, signalled by
 *    `autoApprovePermissions`). Codex's default `agent` (workspace-write)
 *    sandbox BLOCKS network — including the loopback socket to the shared
 *    Beads/Dolt server on 127.0.0.1:3308 — so `bd create` and any other infra
 *    that talks to localhost/network fail. `agent-full-access` enables network
 *    (its approval policy is "never", which matches the auto-approve we already
 *    do in this plane). Interactive runs on a user's own machine — neither
 *    CODESPACES nor CODEAM_AUTO_APPROVE set — keep Codex's safe default mode.
 *    The codex-acp adapter reads its starting mode from this env var.
 */
export function computeAdapterExtraEnv(params: {
  agent: AgentId;
  autoApprovePermissions?: boolean;
  disable1mContext: boolean;
}): Record<string, string> {
  const env: Record<string, string> = {};
  // Agent-agnostic knob — the per-session 1M-context opt-out applies to any
  // agent (only Claude reads it, but setting it elsewhere is harmless).
  if (params.disable1mContext) env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1';
  // Per-agent spawn env comes from the agent-hooks registry (Codex's
  // INITIAL_AGENT_MODE=agent-full-access in the autonomous plane). Adding a new
  // agent's spawn quirk means adding a `startupExtraEnv` hook, not a branch here.
  Object.assign(
    env,
    agentHooks(params.agent)?.startupExtraEnv?.({
      autoApprovePermissions: params.autoApprovePermissions,
    }) ?? {},
  );
  return env;
}

export async function runAcpSession(opts: AcpRunnerOptions): Promise<void> {
  const publisher = new AcpPublisher({
    sessionId: opts.sessionId,
    pluginId: opts.pluginId,
    pluginAuthToken: opts.pluginAuthToken,
    refreshAuthToken: () =>
      fetchCurrentPluginAuthToken(opts.sessionId, opts.pluginId, opts.pollSecret),
  });
  const streaming = new StreamingState(publisher);
  // Small ring of recent adapter stderr lines so a turn that fails on an auth
  // 401 (printed to stderr, never to the ACP text stream) can be classified
  // and surfaced as a persistent re-auth bubble. Capped — never unbounded.
  const recentStderr: string[] = [];

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
  // On-demand 1M-context disable (Rafael 2026-06-24): claude Code v2.1.x sends
  // the `context-1m` beta even on accounts without 1M usage credits → 429
  // "Usage credits required for 1M context". When the user previously chose
  // "Disable 1M context and continue" for THIS session, the flag is persisted
  // and re-applied on every (re)spawn via the adapter env.
  const disable1mContext =
    loadCliConfig().sessions.find((s) => s.pluginId === opts.pluginId)?.disable1mContext === true;
  const extraEnv = computeAdapterExtraEnv({
    agent: opts.agent,
    autoApprovePermissions: opts.autoApprovePermissions,
    disable1mContext,
  });
  const clientOptions: AcpClientOptions = {
    adapter: opts.adapter,
    cwd: opts.cwd,
    extraEnv,
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
      // AUTO mode (headless / codespace): no human at the phone to answer, so
      // auto-pick an "allow" option instead of stalling the turn forever. Pick
      // the broadest grant available (allow_always > allow_once). If the agent
      // somehow offers no allow option, fall through to the interactive flow.
      if (opts.autoApprovePermissions) {
        const allow = pickAllowOption(request.options);
        if (allow) {
          log.info(
            'acpRunner',
            `AUTO mode — auto-approving permission (${allow.kind}) optionId=${allow.optionId}`,
          );
          return { outcome: { outcome: 'selected', optionId: allow.optionId } };
        }
        log.warn('acpRunner', 'AUTO mode — no allow option offered; falling back to interactive');
      }
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
    onStderr: (line) => {
      // AcpClient.start() already mirrors stderr to `log.info('acpAdapter')`
      // for CODEAM_DEBUG smoke tests. We ALSO keep a small ring of recent
      // lines so a turn that dies on an auth 401 (stderr-only) can be
      // classified below and surfaced as a persistent re-auth message.
      recentStderr.push(line);
      if (recentStderr.length > 40) recentStderr.shift();
    },
    onUnexpectedExit: (code, signal) => {
      log.warn('acpRunner', `adapter died code=${code} signal=${signal}; shutting down session`);
      // closeAll() flushes any half-streamed text with done:true so
      // mobile flips out of "Thinking…" instead of leaving the
      // partial reply hanging forever. Followed by a terminal message so
      // the user knows WHY the session died — a credential 401 gets the
      // actionable re-auth copy instead of a raw exit code.
      const authFail = looksLikeAuthFailure(recentStderr.join('\n'));
      // Provider outage (Anthropic 529 / upstream 5xx) can crash the adapter
      // too — surface the transparent "provider is down + status link" bubble
      // instead of a cryptic exit-code message.
      const outageFail = !authFail && looksLikeProviderOutage(recentStderr.join('\n'));
      // Classify the exit. `null` = benign user-initiated shutdown
      // (Windows Ctrl+C / console-close 0xC000013A, or POSIX SIGINT) —
      // NOT a crash, so we flush but publish NO error bubble (it was
      // landing in the daily digest as a fake failed session).
      const message = adapterExitMessage({ code, signal, authFail, outageFail, agent: opts.agent });
      const benign = message === null;
      if (authFail) {
        // Durably flag the LinkedAgent credential invalid so Profile › Agents
        // shows EXPIRED + the re-auth CTA (instead of CONNECTED from a
        // dead-but-present refresh token). Best-effort — never blocks exit.
        void reportCredentialInvalid(opts);
      }
      // Flush the terminal frame BEFORE exiting. The old code chained
      // the error POST off closeAll().then(...) and called
      // process.exit(1) synchronously, so the frame almost never made
      // it onto the wire — mobile then sat on "Thinking…" forever.
      // Await it under a 5 s deadline so a wedged socket can't hang
      // teardown. (Task 1 makes these POSTs survive a stale token.)
      void (async () => {
        await withTimeout(
          (async () => {
            await streaming.closeAll();
            // Only publish a terminal bubble for a REAL failure. On a
            // benign shutdown closeAll() already flushed any partial reply
            // with done:true, so mobile leaves "Thinking…" without a
            // spurious crash message.
            if (message !== null) {
              await publisher.publishOutput({ type: 'text', content: message, done: true });
            }
          })(),
          5_000,
        );
        // Clean exit for a user-initiated shutdown; failure code otherwise.
        process.exit(benign ? 0 : 1);
      })();
    },
  };
  // `client` is never re-spawned in-session: the old on-demand 1M-context
  // disable/re-spawn recovery was removed (the fix for a 1M-credits gate is to
  // RECONNECT the subscription, not disable 1M — see failure-messages.ts).
  const client = new AcpClient(clientOptions);

  // ─── On-demand Headroom budget-exceeded recovery ──────────────────────────
  // When the local Headroom proxy 429s due to budget exhaustion, offer two
  // tappable options: "Pause budget this session" (relaunch proxy w/o --budget)
  // or "Raise budget" (deep-link to app settings). Fire-once POST to the
  // backend's budget-reached endpoint so the app can reflect the state.
  //
  // Fire-once guard: we POST the backend notification at most once per session
  // (not once per turn) so a repeated budget-exceeded series doesn't spam the
  // backend endpoint. Subsequent occurrences still surface the recovery bubble.
  let _budgetReachedPosted = false;

  const relaunchProxyWithoutBudget = async (): Promise<void> => {
    const { spawn } = await import('node:child_process');
    // Kill the budget-capped proxy — targeted pidfile kill, falling back to
    // the legacy pkill pattern when no live recorded pid exists.
    killHeadroomProxy();
    // Brief settle so the port frees before relaunch.
    await new Promise<void>((r) => setTimeout(r, 500));
    // Re-spawn without budget args.
    // buildRelaunchProxyEnv clears both budget env keys so the "paused" proxy
    // inherits NO budget cap — neither flag nor env — even when the
    // headroom_budget handler had previously written them into process.env.
    const proxyEnv = buildRelaunchProxyEnv(process.env);
    try {
      const proxy = spawn(
        'headroom',
        ['proxy', '--port', '8787'],
        { stdio: 'ignore', detached: true, env: proxyEnv as NodeJS.ProcessEnv },
      );
      proxy.once('error', (e: Error) => {
        log.warn('acpRunner', `budget recovery proxy relaunch error (best-effort): ${e.message}`);
      });
      proxy.unref();
      writeHeadroomProxyPidfile(proxy.pid);
    } catch (e) {
      log.warn(
        'acpRunner',
        `budget recovery proxy relaunch failed (best-effort): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // Settle: give the proxy ~3 s to start accepting connections.
    await new Promise<void>((r) => setTimeout(r, 3_000));
  };

  const budgetRecovery = createBudgetRecovery<PromptBlock>({
    publishText: (text) => publisher.publishOutput({ type: 'text', content: text, done: true }),
    publishSelectPrompt: (question, options) =>
      publisher.publishOutput({
        type: 'select_prompt',
        content: question,
        options,
        optionDescriptions: options.map(() => ''),
        currentIndex: 0,
        done: true,
      }),
    publishAwaitingAnswer: (prompt, options) =>
      publisher.publishAwaitingAnswer({ questionId: randomUUID(), prompt, options }),
    publishRawChunk: (chunk) => publisher.publishOutput(chunk),
    sendResult: (commandId, status, result) => relay.sendResult(commandId, status, result),
    appendAgentReply: (text) => history.appendAgentReply(text),
    flushHistory: () => void history.flush(),
    relaunchProxyWithoutBudget,
    agentId: opts.agent,
    log: (msg) => log.info('acpRunner', msg),
  });

  showInfo(`Starting ${opts.agent} via ACP adapter (${opts.adapter.requiresAgentBinary})…`);
  let handshake: Awaited<ReturnType<typeof client.start>>;
  try {
    handshake = await client.start();
  } catch (startErr) {
    // The agent never created a session (e.g. Gemini's Code Assist onboarding
    // rejecting the account post-2026-06-18). Without this the session sat on
    // "STILL LOADING SESSION HISTORY / offline" forever — pair-auto exited and
    // the plugin never came online. Surface WHY: bring the plugin ONLINE with a
    // minimal relay and publish a clear, actionable message into the chat.
    const detail = describeError(startErr);
    log.warn('acpRunner', `ACP start failed for ${opts.agent}: ${detail}`);
    await surfaceStartupFailure({
      agent: opts.agent,
      pluginId: opts.pluginId,
      detail,
      recentStderr: recentStderr.join('\n'),
      publisher,
    });
    return;
  }
  const {
    sessionId: acpSessionId,
    initialize,
    model: handshakeModel,
    tier: handshakeTier,
  } = handshake;
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

  // Canonical-transcript uploader. ACP agents (claude/codex/gemini) DO write the
  // same `~/.claude/projects/<cwd>/<sessionId>.jsonl` the legacy PTY path parses
  // — the ACP runner just never uploaded it. So when the LIVE streaming-chunk
  // render truncated mid-reply (an SSE idle-cycle, a dropped frame), the backend
  // had NO canonical conversation to serve and the chat froze with no way to
  // heal (the recurring "chat stuck but the preview has the full reply"). On
  // `get_conversation` we now read + upload that JSONL via the legacy
  // HistoryService so the app can fetch the full transcript and replace a
  // truncated turn. `runtime` is the same per-agent strategy `listModels` used.
  const jsonlHistory = new HistoryService(runtime, opts.pluginId, opts.cwd, {
    pluginAuthToken: opts.pluginAuthToken,
  });

  // First-pair onboarding: right after the welcome card, publish a short
  // CodeAgent Mobile intro. It's a HARDCODED message (not generated by the
  // agent) — purely informational, so no model round-trip: it lands instantly
  // and reliably regardless of how long beads/agent startup takes. Runs as a
  // normal turn (clear + new_turn → text → done) AND records into the
  // conversation anchor via `history`, so it survives a SessionDetail opened
  // AFTER the turn finished (the chat reads the anchor; SSE catchup drops
  // historical text). Once per paired session; skipped on reconnects. Non-fatal.
  // Kicked off here so it streams concurrently with the watcher/relay setup
  // below, but we AWAIT it right before `relay.start()` so the welcome turn
  // has fully closed before any command turn can begin on the shared
  // StreamingState — otherwise the first `start_task` interleaves with the
  // in-flight welcome and the user's first prompt gets answered by the
  // greeting (#339).
  const onboardingWelcomeDone = maybeSendOnboardingWelcome({
    streaming,
    history,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
  });

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

  // Beads is provisioned by the composition root (`start()`), NOT here
  // (SRP decision D10) — this runner is pure agent. `opts.getBeads`
  // returns the live handle the composition root owns so relayed
  // `beads_action` commands can route into `handleBeadsActionCommand`.
  const getBeads = opts.getBeads ?? (() => null);

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
        jsonlHistory,
        initialize.agentCapabilities,
        turnFiles,
        getBeads,
        publisher,
        recentStderr,
        budgetRecovery,
        { get: () => _budgetReachedPosted, set: (v: boolean) => { _budgetReachedPosted = v; } },
      );
    },
    { id: opts.agent, name: opts.agent, displayName: opts.agent } as never,
  );
  // Serialize against the onboarding welcome (#339): wait for its turn to
  // fully close before the relay can start a command turn on the shared
  // StreamingState. Non-fatal internally, so this never rejects.
  await onboardingWelcomeDone;
  relay.start();

  // Proactive credential check on wake: if the agent's LOCAL token is
  // unrecoverably expired (e.g. it lapsed while the codespace slept), surface
  // the re-auth bubble now — before the user spends a turn discovering it
  // (the 2026-07-05 "two wasted turns then 401" incident). Network-free local
  // expiry only; a healthy/refreshable/API-key credential is a silent no-op.
  void createWakeCredentialProbe({
    getStatus: () => localCredentialExpiryStatus(opts.agent),
    emitReauthBubble: async () => {
      await publisher.publishOutput({ type: 'new_turn', done: false });
      await publisher.publishOutput({ type: 'text', content: AUTH_FAILURE_MESSAGE, done: true });
      history.appendAgentInitiatedReply(AUTH_FAILURE_MESSAGE);
      await history.flush();
    },
    reportCredentialInvalid: () => reportCredentialInvalid(opts),
    log: (msg) => showInfo(msg),
  }).run();

  // Pre-warm project-type detection so the user's first "Start Preview" is
  // instant (skips the ~50 s detect step). Fired ~20 s after the session is
  // up so it clears the boot window, then runs a headless `claude -p`
  // one-shot in the background and caches `.codeam/preview.json`. Idempotent
  // + non-fatal; cleared on shutdown so a quick teardown doesn't fire it.
  const prewarmTimer = setTimeout(() => prewarmPreviewDetection(runtime), 20_000);

  const shutdown = async (signal: NodeJS.Signals) => {
    showInfo(`Shutting down ACP session (${signal})…`);
    clearTimeout(prewarmTimer);
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
 * Map a relay command to the ACP equivalent — thin positional-args compat
 * wrapper over {@link dispatchAcpCommand}. The per-command handler bodies and
 * the dispatch table live in `command-handlers.ts` (keyed off one flat
 * {@link AcpCommandContext} instead of these positional parameters); this
 * wrapper only bundles the arguments into that context object. Kept exported
 * with the pre-extraction signature because the relay callback above and the
 * existing acp.*.test suites drive it directly.
 *
 * Contract (owned by the dispatch table): every command MUST be acked via
 * `relay.sendResult(cmd.id, status, result)` exactly once. Without an ack the
 * backend keeps the command in "pending" and mobile's auto-refresh loops
 * (notably `get_conversation` every ~20 s) retry forever — manifests as the
 * mobile chat sitting empty while the CLI looks like it's hung.
 */
export async function handleCommand(
  cmd: RemoteCommand,
  client: AcpClient,
  relay: CommandRelayService,
  acpSessionId: string,
  models: AgentModel[],
  streaming: StreamingState,
  opts: AcpRunnerOptions,
  history: AcpHistory,
  jsonlHistory: HistoryService,
  agentCaps: { loadSession?: boolean } | undefined,
  turnFiles: TurnFileAggregator,
  getBeads: () => StartedBeads | null,
  publisher: AcpPublisher,
  recentStderr: string[],
  /** On-demand Headroom budget-exceeded recovery (offer pause/raise options). */
  budgetRecovery: BudgetRecovery<PromptBlock>,
  /** Fire-once guard for the budget-reached backend POST. */
  budgetReachedFlag: { get: () => boolean; set: (v: boolean) => void },
): Promise<void> {
  await dispatchAcpCommand({
    cmd,
    client,
    relay,
    acpSessionId,
    models,
    streaming,
    opts,
    history,
    jsonlHistory,
    agentCaps,
    turnFiles,
    getBeads,
    publisher,
    recentStderr,
    budgetRecovery,
    budgetReachedFlag,
  });
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
