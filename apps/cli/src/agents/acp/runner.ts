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
import { _postJsonAuthed } from '../../services/pairing.service';
import { resolveApiBaseUrl } from '@codeagent/shared';
import { log } from '../../services/logger';
import { HistoryService } from '../../services/history.service';
import { showInfo, showSuccess, showRelayNotice } from '../../ui/banner';
import { AGENT_REGISTRY, type AgentId, type AgentModel, type StreamingChunkKind } from '@codeagent/shared';
import type { RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { createOsStrategy } from '../../os';
import { createInteractiveAgentStrategy } from '../registry';
import { AcpClient } from './client';
import type { AdapterSpec } from './adapters';
import { AcpPublisher } from './publisher';
import { buildAcpPromptBlocks } from './buildAcpPromptBlocks';
import { reconcileCumulative } from './reconcileDelta';
import { maybeSendOnboardingWelcome } from './onboarding';
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
  prewarmPreviewDetection,
  type HandlerContext,
} from '../../commands/start/handlers';
import type { RuntimeStrategy } from '../strategy';
import { removeSession } from '../../config';
import { FileWatcherService } from '../../services/file-watcher.service';
import { TurnFileAggregator } from '../../services/turn-files/turn-file-aggregator';
import { beadsActionFromPayload } from '../../beads/wiring';
import { handleBeadsActionCommand, type StartedBeads } from '../../beads';

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
    // the reply-doubling bug (see turnTextChunkId). Non-text kinds keep
    // their own id within the turn: thinking / tool_use / tool_result are
    // distinct bubbles.
    const baseId =
      delta.kind === 'text' ? (this.turnTextChunkId ??= delta.chunkId) : delta.chunkId;
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

/**
 * Patterns that mean the agent's PROVIDER credential is invalid/expired (a
 * mid-session 401) rather than a transient network/tool error. The agent CLI
 * (Claude Code, Codex, …) prints this to stderr and exits — it never reaches
 * the ACP text stream — so a turn that fails on it would otherwise leave only
 * a transient flash that's gone on the next `clear`/reconnect. We classify
 * the failure and surface {@link AUTH_FAILURE_MESSAGE} as a persistent bubble.
 */
const AUTH_FAILURE_RE =
  /invalid authentication credentials|authentication[_ ]error|please run \/login|\bunauthorized\b|\binvalid x-api-key\b|oauth token (?:expired|revoked)|(?:api error|http|status)[:\s]+401|\b401\b[^\n]{0,40}(?:unauthor|authenticat|credential|api[_ ]?key|login)/i;

export function looksLikeAuthFailure(text: string): boolean {
  return AUTH_FAILURE_RE.test(text);
}

/**
 * Persistent, actionable message shown in the chat when a turn fails because
 * the agent's credential is invalid/expired. Markdown — the chat renderer
 * supports it (same as the welcome banner).
 */
const AUTH_FAILURE_MESSAGE =
  '🔒 **Authentication failed — your agent credentials are invalid or expired (API 401).**\n\n' +
  // `codeam://reauth` is an in-app deep-link the mobile chat intercepts
  // (MarkdownAppLinkProvider → Profile › Agents, preselecting this agent).
  // On any surface that can't handle the scheme it just renders as a tappable
  // label, so the instruction still reads correctly.
  'Tap [Re-authenticate this agent](codeam://reauth) to renew your credentials in Profile › Agents, then send your message again.';

/**
 * Persistent, actionable message for a NON-auth turn failure that produced no
 * assistant text (e.g. the local Headroom proxy not ready on the first prompt,
 * a network/adapter error). Without this the only frame published is the empty
 * `done:true` from `closeAll`, which the mobile snapshot-guard drops — leaving
 * the chat with no reply AND no error (the silent "first message never
 * answers" bug). Surfacing this guarantees every turn visibly ends.
 */
export const TURN_FAILURE_MESSAGE =
  '⚠️ **The agent hit an error and couldn’t finish this turn.** Please send your message again.';

export { AUTH_FAILURE_MESSAGE };

/**
 * Decide the terminal failure bubble to publish when a `start_task` turn
 * throws — the contract that guarantees a turn NEVER ends silently:
 *   - auth failure → the actionable re-auth bubble.
 *   - any other failure that streamed NO assistant text → a generic retry
 *     bubble (the fix for the silent "first message never answers" bug: the
 *     only other frame is an empty `done:true` the mobile snapshot-guard drops).
 *   - a failure that DID stream partial text → null: `closeAll` already
 *     published that partial reply as the terminal frame; don't clobber it.
 */
export function failureBubble(opts: {
  detail: string;
  recentStderr: string;
  hadText: boolean;
}): string | null {
  if (looksLikeAuthFailure(opts.detail) || looksLikeAuthFailure(opts.recentStderr)) {
    return AUTH_FAILURE_MESSAGE;
  }
  if (!opts.hadText) return TURN_FAILURE_MESSAGE;
  return null;
}

/**
 * Handle a `get_conversation` command for an ACP agent: upload the on-disk
 * JSONL transcript (`<acpSessionId>.jsonl`) as the canonical conversation so
 * the app can fetch the full history and HEAL a truncated live turn, then ack
 * with the conversation id. Extracted + exported so the upload-then-ack
 * contract is unit-testable (the bug was: the handler acked WITHOUT uploading,
 * so a truncated turn had no canonical source and froze forever).
 *
 * The upload is BEST-EFFORT — a missing JSONL or a network error must never
 * fail the command (the live streaming-chunk feed stays the primary surface),
 * so we always ack the id regardless.
 */
export async function handleGetConversation(args: {
  relay: Pick<CommandRelayService, 'sendResult'>;
  commandId: string;
  jsonlHistory: Pick<HistoryService, 'uploadConversationIfChanged'>;
  acpSessionId: string;
}): Promise<void> {
  const { relay, commandId, jsonlHistory, acpSessionId } = args;
  try {
    // mtime-gated: only re-uploads when the JSONL grew (a new turn), so the
    // ~20 s poll doesn't re-ship the full transcript every tick.
    await jsonlHistory.uploadConversationIfChanged(acpSessionId);
  } catch (err) {
    log.trace(
      'acpRunner',
      `get_conversation transcript upload failed (best-effort): ${describeError(err)}`,
    );
  }
  await relay.sendResult(commandId, 'completed', { conversationId: acpSessionId });
}

export async function runAcpSession(opts: AcpRunnerOptions): Promise<void> {
  const publisher = new AcpPublisher({
    sessionId: opts.sessionId,
    pluginId: opts.pluginId,
    pluginAuthToken: opts.pluginAuthToken,
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
      if (authFail) {
        // Durably flag the LinkedAgent credential invalid so Profile › Agents
        // shows EXPIRED + the re-auth CTA (instead of CONNECTED from a
        // dead-but-present refresh token). Best-effort — never blocks exit.
        void fetch(
          `${resolveApiBaseUrl()}/api/plugin/agents/${encodeURIComponent(opts.agent)}/credential-invalid`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Plugin-Auth-Token': opts.pluginAuthToken,
            },
            body: JSON.stringify({ sessionId: opts.sessionId, pluginId: opts.pluginId }),
          },
        ).catch(() => undefined);
      }
      void streaming.closeAll().then(() =>
        publisher.publishOutput({
          type: 'text',
          content: authFail
            ? AUTH_FAILURE_MESSAGE
            : `Agent adapter exited unexpectedly (code=${code ?? 'null'} signal=${signal ?? 'null'}).`,
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
      );
    },
    { id: opts.agent, name: opts.agent, displayName: opts.agent } as never,
  );
  // Serialize against the onboarding welcome (#339): wait for its turn to
  // fully close before the relay can start a command turn on the shared
  // StreamingState. Non-fatal internally, so this never rejects.
  await onboardingWelcomeDone;
  relay.start();

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
  jsonlHistory: HistoryService,
  agentCaps: { loadSession?: boolean } | undefined,
  turnFiles: TurnFileAggregator,
  getBeads: () => StartedBeads | null,
  publisher: AcpPublisher,
  recentStderr: string[],
): Promise<void> {
  switch (cmd.type) {
    case 'beads_action': {
      // Mobile-originated Beads action relayed as a command. Replay it
      // as a native `bd` command via the orchestrator, then push the
      // resulting snapshot. Strictly non-fatal + always acks so mobile
      // doesn't retry on a loop. No-op when beads isn't running.
      const beads = getBeads();
      const action = beadsActionFromPayload(cmd.payload);
      if (!beads || !action) {
        await relay.sendResult(cmd.id, 'completed', { applied: false });
        return;
      }
      try {
        await handleBeadsActionCommand(action, beads);
        await relay.sendResult(cmd.id, 'completed', { applied: true });
      } catch (err) {
        log.warn('acpRunner', `beads_action failed (non-fatal): ${describeError(err)}`);
        await relay.sendResult(cmd.id, 'failed', { error: describeError(err) });
      }
      return;
    }
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
        // Whether the turn streamed any assistant text BEFORE recover resets
        // it. When it did, `closeAll` already published that partial reply as
        // the terminal frame — we must NOT clobber it. When it didn't, the only
        // frame is an empty `done:true` (dropped by the mobile snapshot-guard),
        // so we MUST synthesize a visible failure bubble below.
        const hadText = streaming.getCurrentText().trim().length > 0;
        // Error path uses the safe closeAll (no extraction) — a
        // torn-off text could match the heuristics spuriously and
        // strand the runner with an unanswerable pending question.
        await recoverFromFailedTurn(client, streaming);
        const detail = describeError(err);
        log.warn('acpRunner', `prompt failed: ${detail}`);
        // GUARANTEE a visible terminal frame: recoverFromFailedTurn's closeAll
        // only published the accumulated ASSISTANT text — empty on a first-turn
        // proxy/network/auth failure, which the mobile snapshot-guard drops,
        // leaving the chat with no reply AND no error. failureBubble() decides
        // the actionable message (re-auth, or generic retry when no text
        // streamed); null only when a partial reply already serves as terminal.
        const bubble = failureBubble({
          detail,
          recentStderr: recentStderr.join('\n'),
          hadText,
        });
        if (bubble) {
          await publisher.publishOutput({ type: 'text', content: bubble, done: true });
          // Persist it in the DURABLE conversation (the output stream is just a
          // 3-min buffer the next turn's `clear` wipes — and mobile re-fetches
          // `get_conversation` on a loop). Without this the bubble shows live
          // then disappears on the next refresh.
          history.appendAgentReply(bubble);
          void history.flush();
        }
        await relay.sendResult(cmd.id, 'failed', { error: detail });
      }
      return;
    }
    case 'group_mention_task': {
      // `@codeagent` mention forwarded from a Team Space. The backend
      // (AgentTasksService.enqueueForGroupMention) resolved the sender's
      // default agent + active session and pushed this command. We run
      // the prompt as a NORMAL turn on the active session — so the user
      // sees the agent working in their own chat (Option 1) — then POST
      // the final reply to /agent-tasks/:id/complete, which round-trips
      // it into the originating group as an `agent_reply`.
      const payload = cmd.payload as { taskId?: string; prompt?: string };
      const taskId = typeof payload?.taskId === 'string' ? payload.taskId : '';
      const promptText =
        typeof payload?.prompt === 'string' ? payload.prompt : '';
      if (!taskId || !promptText.trim()) {
        await relay.sendResult(cmd.id, 'failed', {
          error: 'invalid group_mention_task payload',
        });
        return;
      }
      await streaming.beginTurn();
      history.appendUserPrompt(promptText);
      let response = '';
      let status: 'completed' | 'failed' = 'completed';
      try {
        await client.prompt(promptText);
        response = streaming.getCurrentText();
        await streaming.closeTurnWithInteractiveDetection();
        history.appendAgentReply(response);
        void history.flush();
      } catch (err) {
        status = 'failed';
        response = describeError(err);
        await recoverFromFailedTurn(client, streaming);
      }
      // Round-trip the reply into the group. Best-effort: a failed POST
      // (network blip, expired token, already-completed row) must not
      // crash the runner — the command result still acks below so mobile
      // doesn't retry-loop.
      try {
        await _postJsonAuthed(
          `${resolveApiBaseUrl()}/api/agent-tasks/${encodeURIComponent(taskId)}/complete`,
          {
            sessionId: opts.sessionId,
            pluginId: opts.pluginId,
            response: response.slice(0, 32 * 1024),
            status,
          },
          opts.pluginAuthToken,
        );
      } catch (err) {
        log.warn(
          'acpRunner',
          `group_mention_task ${taskId.slice(0, 8)} complete POST failed: ${describeError(err)}`,
        );
      }
      await relay.sendResult(cmd.id, status, { taskId });
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
      // ACP agents (claude/codex/gemini) DO write the same on-disk JSONL the
      // legacy path parses (`<acpSessionId>.jsonl`). Upload it as the canonical
      // conversation so the app can fetch the full transcript and HEAL a
      // truncated live turn — then ack with the id. Best-effort; the live
      // streaming-chunk bus stays the primary surface.
      await handleGetConversation({
        relay,
        commandId: cmd.id,
        jsonlHistory,
        acpSessionId,
      });
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
            await recoverFromFailedTurn(client, streaming);
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
        await recoverFromFailedTurn(client, streaming);
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
        await recoverFromFailedTurn(client, streaming);
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
 * Recover the ACP session after a turn fails, then flush the chat out
 * of "Thinking…".
 *
 * The idle-timeout watchdog (and some adapter errors) reject the SDK
 * `prompt()` while the adapter's turn is STILL running — our side gave
 * up, but the agent never received a stop. The adapter advertises
 * `promptQueueing`, so the NEXT prompt then queues behind that dead
 * turn and never runs: the session is poisoned (observed as "the agent
 * stops responding — every later message just sits on Thinking…", with
 * the agent process alive but idle). Cancelling the turn on the adapter
 * frees the session so the next prompt starts clean.
 *
 * Both steps are best-effort and independent: a cancel against an
 * already-dead adapter may itself throw, and we still want to flush the
 * UI regardless.
 */
export async function recoverFromFailedTurn(
  client: AcpClient,
  streaming: StreamingState,
): Promise<void> {
  try {
    await client.cancel();
  } catch (err) {
    log.warn('acpRunner', `post-failure cancel failed: ${describeError(err)}`);
  }
  await streaming.closeAll();
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
