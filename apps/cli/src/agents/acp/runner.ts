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

import { randomUUID } from 'node:crypto';
import { CommandRelayService, type RemoteCommand } from '../../services/command-relay.service';
import { log } from '../../services/logger';
import { showInfo, showSuccess } from '../../ui/banner';
import type { AgentId, AgentModel } from '@codeagent/shared';
import { createOsStrategy } from '../../os';
import { createInteractiveAgentStrategy } from '../registry';
import { AcpClient } from './client';
import type { AdapterSpec } from './adapters';
import { AcpPublisher } from './publisher';
import { mapSessionUpdate, mapPermissionRequest } from './mappers';

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

  const client = new AcpClient({
    adapter: opts.adapter,
    cwd: opts.cwd,
    onSessionUpdate: (notification) => {
      const chunks = mapSessionUpdate(notification);
      for (const chunk of chunks) {
        void publisher.publishChunk(chunk);
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
    onStderr: (line) => {
      log.trace('acpAdapter', line);
    },
    onUnexpectedExit: (code, signal) => {
      log.warn('acpRunner', `adapter died code=${code} signal=${signal}; shutting down session`);
      // Surface the failure as a final text chunk so the mobile
      // doesn't sit on a stale "thinking…" forever. The chunkId
      // is fresh so this lands as its own bubble rather than
      // overwriting in-flight content.
      void publisher.publishChunk({
        chunkId: randomUUID(),
        kind: 'text',
        content: `Agent adapter exited unexpectedly (code=${code ?? 'null'} signal=${signal ?? 'null'}).`,
        isFinal: true,
      });
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
      await handleCommand(cmd, client, relay, acpSessionId, models);
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
      try {
        const reply = await client.prompt(prompt);
        await relay.sendResult(cmd.id, 'completed', { stopReason: reply.stopReason });
      } catch (err) {
        log.warn('acpRunner', `prompt failed: ${describeError(err)}`);
        await relay.sendResult(cmd.id, 'failed', { error: describeError(err) });
      }
      return;
    }
    case 'stop_task':
    case 'escape_key': {
      try {
        await client.cancel();
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
