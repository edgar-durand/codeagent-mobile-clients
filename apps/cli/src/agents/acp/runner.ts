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
 *   - session/request_permission → awaiting-answer + 1.5 s polling
 *     for the user's reply, then resolve the ACP request with the
 *     matching `optionId`.
 *
 * Out of scope for Phase 1 — we route these to a "not supported in
 * ACP mode" notice rather than silently dropping:
 *   - resume_session, change_model, list_models, summarize
 *
 * File / git / preview / AI-summary handlers don't need the agent
 * runtime and continue to work because we reuse the existing
 * handler registry verbatim for those.
 */

import { CommandRelayService, type RemoteCommand } from '../../services/command-relay.service';
import { log } from '../../services/logger';
import { showInfo, showSuccess } from '../../ui/banner';
import type { AgentId, AgentModel, StreamingChunkKind } from '@codeagent/shared';
import { createOsStrategy } from '../../os';
import { createInteractiveAgentStrategy } from '../registry';
import { AcpClient } from './client';
import type { AdapterSpec } from './adapters';
import { AcpPublisher } from './publisher';
import { mapSessionUpdate, mapPermissionRequest } from './mappers';

/**
 * Per-turn accumulator that bridges ACP's delta-shaped notifications
 * to the legacy `/api/commands/output` chat pipe mobile actually
 * reads (see {@link AcpPublisher.publishOutput} for the wire shape).
 *
 * The legacy pipe coalesces by `(sessionId, type)` — successive text
 * events with the same type overwrite each other until one lands
 * with `done: true`. We accumulate per ACP message-id so ordering is
 * preserved, then flush each accumulated buffer as `{ type: 'text',
 * content: <cumulative>, done: false }` per delta. `closeAll()`
 * re-flushes the final cumulative content with `done: true` so
 * mobile flips the bubble out of "Thinking…".
 *
 * Note: ACP `thinking` and `tool_call` notifications also flow
 * through here for Phase 1, but get mapped to `type: 'text'` on the
 * legacy pipe — that pipe only renders text in the chat surface;
 * dedicated thinking/tool bubbles live on the streaming-chunk feed
 * (Epic C, Phase 2 wire-up).
 */
class StreamingState {
  private readonly open = new Map<string, { kind: StreamingChunkKind; content: string }>();

  constructor(private readonly publisher: AcpPublisher) {}

  /**
   * Boundary events emitted at the start of every turn so mobile
   * wipes the previous reply and shows "Agent is typing…". Mirrors
   * the legacy `outputSvc.newTurn()` — `critical: true` on those
   * sends is implicit here (publishOutput retries on transient
   * failures so the boundary always lands).
   */
  async beginTurn(): Promise<void> {
    this.open.clear();
    await this.publisher.publishOutput({ type: 'clear' });
    await this.publisher.publishOutput({ type: 'new_turn', done: false });
  }

  append(delta: { chunkId: string; kind: StreamingChunkKind; delta: string }): void {
    const existing = this.open.get(delta.chunkId);
    const content = (existing?.content ?? '') + delta.delta;
    if (existing && existing.kind !== delta.kind) {
      log.warn(
        'acpRunner',
        `chunk kind flip detected chunkId=${delta.chunkId.slice(0, 8)} from=${existing.kind} to=${delta.kind} — using new kind`,
      );
    }
    this.open.set(delta.chunkId, { kind: delta.kind, content });
    // Phase 1: every ACP variant maps to `type: 'text'` on the
    // legacy chat pipe. Thinking + tool bubbles need the Epic C
    // streaming-chunk feed which isn't wired up yet.
    void this.publisher.publishOutput({ type: 'text', content, done: false });
  }

  /**
   * Flush every open buffer with `done: true` so mobile flips out
   * of "Thinking…". Idempotent — safe to call multiple times per
   * turn (prompt-completed, cancel, adapter-exit).
   *
   * Also emits an empty `{type:'text', content:'', done:true}` when
   * the turn produced no text at all (e.g. Claude responded with
   * tool calls only) so mobile doesn't sit on "Thinking…" forever
   * waiting for content that will never arrive.
   */
  async closeAll(): Promise<void> {
    if (this.open.size === 0) {
      await this.publisher.publishOutput({ type: 'text', content: '', done: true });
      return;
    }
    const closing = Array.from(this.open.values());
    this.open.clear();
    // Emit the final cumulative content for each accumulated buffer;
    // the last one carries done:true to mark the whole turn complete.
    // Single-buffer turn (the common case for a plain chat reply)
    // collapses to one POST.
    for (let i = 0; i < closing.length; i += 1) {
      const isLast = i === closing.length - 1;
      await this.publisher.publishOutput({
        type: 'text',
        content: closing[i].content,
        done: isLast,
      });
    }
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

/** Resolution interval for the pending-answer poll. Matches the
 *  legacy emitter — short enough to feel instant on mobile, long
 *  enough to stay well under any sane rate limit. */
const ANSWER_POLL_MS = 1500;

/** Max time we'll wait for a permission reply before defaulting to
 *  reject. Same 5 min ceiling the awaiting-answer Redis TTL uses
 *  upstream, so polling beyond that is wasted work. */
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

export async function runAcpSession(opts: AcpRunnerOptions): Promise<void> {
  const publisher = new AcpPublisher({
    sessionId: opts.sessionId,
    pluginId: opts.pluginId,
    pluginAuthToken: opts.pluginAuthToken,
  });
  const streaming = new StreamingState(publisher);

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
      log.info(
        'acpRunner',
        `update #${updateCount} variant=${variant} mappedDeltas=${deltas.length}`,
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
      const answer = await waitForAnswer(publisher, event.questionId);
      if (!answer) {
        // Either the user dismissed without picking OR the upstream
        // TTL expired. The safer default is to reject the call —
        // never auto-approve a tool the user didn't explicitly OK.
        return { outcome: { outcome: 'cancelled' } };
      }
      const optionId = optionIdByLabel[answer.answer];
      if (!optionId) {
        // The mobile sent back a string we didn't map (the user
        // typed free-form into a list selector, or the labels
        // changed between request + reply). Treat as cancel.
        log.warn(
          'acpRunner',
          `pending-answer label not in option map; reply="${answer.answer.slice(0, 80)}"`,
        );
        return { outcome: { outcome: 'cancelled' } };
      }
      return { outcome: { outcome: 'selected', optionId } };
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
  const { sessionId: acpSessionId, initialize } = await client.start();
  log.trace(
    'acpRunner',
    `adapter handshake ok protocolVersion=${initialize.protocolVersion} sessionId=${acpSessionId.slice(0, 8)}`,
  );
  showSuccess(`${opts.agent} online (ACP) — awaiting prompts from mobile.`);

  // Model catalog comes from the registered RuntimeStrategy — same
  // list mobile gets in the legacy PTY path so the model-picker UI
  // stays consistent even when ACP is on.
  const runtime = createInteractiveAgentStrategy(opts.agent, createOsStrategy());
  const models = await runtime.listModels();

  // Command relay — listens for prompts from mobile / web and
  // forwards them as ACP `session/prompt`. Every command branch MUST
  // call `relay.sendResult(...)` even on no-op / not-supported
  // paths; otherwise mobile retries the same command every ~20 s
  // (the dashboard polls `get_conversation` on a loop to refresh
  // the chat surface) and the relay log drowns in duplicates.
  const relay = new CommandRelayService(
    opts.pluginId,
    async (cmd) => {
      await handleCommand(cmd, client, relay, acpSessionId, models, streaming);
    },
    { id: opts.agent, name: opts.agent, displayName: opts.agent } as never,
  );
  relay.start();

  const shutdown = async (signal: NodeJS.Signals) => {
    showInfo(`Shutting down ACP session (${signal})…`);
    relay.stop();
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
): Promise<void> {
  switch (cmd.type) {
    case 'start_task': {
      const payload = cmd.payload as { prompt?: string } | undefined;
      const prompt = payload?.prompt?.trim();
      if (!prompt) {
        log.warn('acpRunner', 'start_task with empty prompt; ignoring');
        await relay.sendResult(cmd.id, 'failed', { error: 'empty prompt' });
        return;
      }
      log.info('acpRunner', `start_task → forwarding prompt chars=${prompt.length} id=${cmd.id.slice(0, 8)}`);
      // Mirror the legacy `outputSvc.newTurn()` boundary: clear the
      // previous reply on mobile + show "Agent is typing…". Without
      // this, mobile keeps showing the previous turn's bubble until
      // the first streaming text overwrites it, which races visibly.
      await streaming.beginTurn();
      try {
        const reply = await client.prompt(prompt);
        // Close every open buffer with done:true so mobile flips
        // the bubble out of "Thinking…".
        await streaming.closeAll();
        log.info('acpRunner', `start_task ← done stopReason=${reply.stopReason ?? '?'} id=${cmd.id.slice(0, 8)}`);
        await relay.sendResult(cmd.id, 'completed', { stopReason: reply.stopReason });
      } catch (err) {
        // Close on failure too so a half-streamed reply doesn't stay
        // mid-air on mobile forever.
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
    default:
      // Everything else (change_model, summarize, file ops, git ops,
      // terminal ops, …) is Phase 2 work for ACP. Acking `failed`
      // with a structured reason lets mobile show a one-line "not
      // supported in ACP mode" affordance instead of timing out.
      log.trace('acpRunner', `command type "${cmd.type}" not supported in Phase 1 ACP mode`);
      await relay.sendResult(cmd.id, 'failed', {
        error: `Command "${cmd.type}" is not supported in Phase 1 ACP mode.`,
      });
      return;
  }
}

/**
 * Poll the pending-answer endpoint until the user replies or the
 * timeout expires. Exposed as a free function (not a method on
 * the publisher) so the runner can drive cancellation from
 * elsewhere later without leaking poll-loop state into the
 * publisher.
 */
async function waitForAnswer(
  publisher: AcpPublisher,
  questionId: string,
): Promise<{ answer: string } | null> {
  const deadline = Date.now() + PERMISSION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const reply = await publisher.pollPendingAnswer(questionId);
    if (reply) return { answer: reply.answer };
    await new Promise((r) => setTimeout(r, ANSWER_POLL_MS));
  }
  return null;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
