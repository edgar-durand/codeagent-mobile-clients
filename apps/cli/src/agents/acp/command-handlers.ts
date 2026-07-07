/**
 * Per-command handlers for the ACP session runner.
 *
 * Extracted from `runner.ts`'s `handleCommand` switch (Phase 3 refactor,
 * bd codeagent-2sa) into the same shape the legacy PTY path already uses
 * (`commands/start/handlers.ts`: HandlerContext + a `Record<type, handler>`
 * dispatch table). Every handler body is VERBATIM from the original switch
 * case — only the parameter plumbing changed (19 positional params →
 * one {@link AcpCommandContext}).
 *
 * Contract (unchanged): every handler MUST call
 * `relay.sendResult(cmd.id, status, result)` exactly once. Without an ack the
 * backend keeps the command in "pending" and mobile's auto-refresh loops
 * (notably `get_conversation` every ~20 s) retry forever — manifests as the
 * mobile chat sitting empty while the CLI looks like it's hung.
 */

import { log } from '../../services/logger';
import { _postJsonAuthed } from '../../services/pairing.service';
import { resolveApiBaseUrl, type AgentModel } from '@codeam/shared';
import { showInfo } from '../../ui/banner';
import { createOsStrategy } from '../../os';
import { createInteractiveAgentStrategy } from '../registry';
import type { RuntimeStrategy } from '../strategy';
import { removeSession } from '../../config';
import { closeAllTerminals } from '../../services/terminal-ops.service';
import type { CommandRelayService, RemoteCommand } from '../../services/command-relay.service';
import type { HistoryService } from '../../services/history.service';
import type { TurnFileAggregator } from '../../services/turn-files/turn-file-aggregator';
import { beadsActionFromPayload } from '../../beads/wiring';
import { handleBeadsActionCommand, type StartedBeads } from '../../beads';
import {
  handlers as legacyHandlers,
  dispatchCommand as legacyDispatchCommand,
  type HandlerContext,
} from '../../commands/start/handlers';
import type { AcpClient } from './client';
import type { AcpPublisher } from './publisher';
import { buildAcpPromptBlocks, type PromptBlock } from './buildAcpPromptBlocks';
import { shouldOfferOneMRecovery, type OneMRecovery } from './oneMContextRecovery';
import {
  looksLikeBudgetExceeded,
  extractBudgetPeriod,
  type BudgetRecovery,
} from './budgetRecovery';
import { formatPromptEchoLine, formatAgentReplyLine } from './promptEcho';
import {
  AUTH_FAILURE_MESSAGE,
  CURSOR_UPGRADE_MESSAGE,
  ONE_M_CREDITS_MESSAGE,
  describeError,
  failureBubble,
  replyIsAuthFailure,
  replyIsCursorUpgradeRequired,
} from './failure-messages';
import { postBudgetReached, reportCredentialInvalid } from './backend-reports';
import type { AcpHistory, AcpRunnerOptions, StreamingState } from './runner';

/**
 * Everything a relayed command needs to execute against the live ACP session.
 * Built once per command by `runAcpSession`'s relay callback (via the
 * `handleCommand` compat wrapper) — one flat bag instead of the previous
 * 19 positional parameters.
 */
export interface AcpCommandContext {
  cmd: RemoteCommand;
  client: AcpClient;
  relay: CommandRelayService;
  acpSessionId: string;
  models: AgentModel[];
  streaming: StreamingState;
  opts: AcpRunnerOptions;
  history: AcpHistory;
  jsonlHistory: HistoryService;
  agentCaps: { loadSession?: boolean } | undefined;
  turnFiles: TurnFileAggregator;
  getBeads: () => StartedBeads | null;
  publisher: AcpPublisher;
  recentStderr: string[];
  /** On-demand 1M-context-credits recovery (offer the disable action +
   *  re-spawn/re-run on tap). Built by runAcpSession so it can mutate the
   *  live `client`. */
  oneMRecovery: OneMRecovery<PromptBlock>;
  /** On-demand Headroom budget-exceeded recovery (offer pause/raise options). */
  budgetRecovery: BudgetRecovery<PromptBlock>;
  /** Fire-once guard for the budget-reached backend POST. */
  budgetReachedFlag: { get: () => boolean; set: (v: boolean) => void };
}

export type AcpCommandHandler = (ctx: AcpCommandContext) => Promise<void>;

/**
 * Static quick-reply chips emitted after every normal ACP turn end.
 *
 * PTY agents surface an agent-specific ghost-text suggestion from the
 * terminal's input area (via `OutputService.tick()`). ACP agents have no
 * idle-prompt detector, so we emit a fixed, broadly-useful set instead.
 *
 * These labels are intentionally generic -- they work across agent types
 * (Claude, Codex, Cursor, Gemini) and prompt styles. Tapping one fills
 * the mobile composer and the user presses Send.
 */
export const ACP_QUICK_REPLIES: string[] = ['Continue', 'Yes, go ahead', 'Explain'];

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
  await cancelStuckTurn(client);
  await streaming.closeAll();
}

/**
 * Cancel half of {@link recoverFromFailedTurn} — stop the adapter's
 * still-running turn (the `promptQueueing` poison) WITHOUT flushing the
 * chat. Used by the catch path when an ACTIONABLE failure bubble will
 * REPLACE the streamed text via {@link StreamingState.closeWithBubble}:
 * the streamed raw text must NOT first be finalised by `closeAll` (that
 * commits it as its own terminal `done:true` bubble, and the later
 * replacement frame can no longer overwrite it — it lands as a SECOND
 * bubble, leaving the raw error pinned above the actionable one). So we
 * cancel, then `closeWithBubble` emits the SINGLE terminal frame.
 * Best-effort — a cancel against an already-dead adapter may throw.
 */
export async function cancelStuckTurn(client: AcpClient): Promise<void> {
  try {
    await client.cancel();
  } catch (err) {
    log.warn('acpRunner', `post-failure cancel failed: ${describeError(err)}`);
  }
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
export function buildLegacyContextForACP(
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
    // The running ACP agent (claude/codex/gemini/cursor). REQUIRED: headroom_configure
    // resolves the agent from ctx.agentId; without it the enable gate sees '' and
    // returns {supported:false} for a real Claude session (the `as unknown` cast
    // below previously hid this missing field from the type checker).
    agentId: opts.agent,
    pluginAuthToken: opts.pluginAuthToken,
  } as unknown as HandlerContext;
}

// ─── Per-command handlers (bodies verbatim from the runner.ts switch) ───────

async function beadsActionH(ctx: AcpCommandContext): Promise<void> {
  const { cmd, relay, getBeads } = ctx;
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

async function startTaskH(ctx: AcpCommandContext): Promise<void> {
  const {
    cmd,
    client,
    relay,
    streaming,
    opts,
    history,
    turnFiles,
    publisher,
    recentStderr,
    budgetRecovery,
    budgetReachedFlag,
  } = ctx;
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
    if (opts.agent === 'cursor' && replyIsCursorUpgradeRequired(finalText)) {
      // Cursor's OWN plan paywall ("Upgrade your plan to continue"): the
      // user's Cursor account is on Free, which doesn't include the headless
      // Agent. NOT a credential problem — swap the bare text for an
      // actionable bubble linking to the user's Cursor account upgrade page.
      // Do NOT reportCredentialInvalid (the login is valid).
      await streaming.closeWithBubble(CURSOR_UPGRADE_MESSAGE);
      history.appendAgentReply(CURSOR_UPGRADE_MESSAGE);
      void history.flush();
      log.info('acpRunner', `start_task ← cursor-plan-upgrade-required id=${cmd.id.slice(0, 8)}`);
      await relay.sendResult(cmd.id, 'failed', { error: 'cursor plan upgrade required' });
    } else if (replyIsAuthFailure(finalText)) {
      // The agent COMPLETED the turn but its reply IS an auth-failure
      // notice ("Not logged in · Please run /login") — a missing/expired
      // credential the agent surfaced as plain text instead of throwing.
      // Swap the raw CLI text for the actionable re-auth bubble and flag
      // the LinkedAgent credential invalid so Profile › Agents shows
      // EXPIRED + the re-link CTA, identical to the throw/exit auth paths.
      await streaming.closeWithBubble(AUTH_FAILURE_MESSAGE);
      history.appendAgentReply(AUTH_FAILURE_MESSAGE);
      void history.flush();
      // Symmetry with the happy path: flush any file changeset the agent
      // produced BEFORE it hit the auth wall. No-ops when there are no
      // hunks (the typical not-logged-in case), so it's pure insurance
      // against silently dropping partial edits.
      turnFiles.flushTurn().catch((err) => {
        log.warn('acpRunner', `turnFiles.flushTurn failed: ${describeError(err)}`);
      });
      void reportCredentialInvalid(opts);
      log.info('acpRunner', `start_task ← auth-failure-in-reply id=${cmd.id.slice(0, 8)}`);
      await relay.sendResult(cmd.id, 'failed', { error: 'agent reply reported auth failure' });
    } else if (
      shouldOfferOneMRecovery({ detail: '', recentStderr: recentStderr.join('\n'), finalText })
    ) {
      // The turn COMPLETED but the reply IS Anthropic's "Usage credits
      // required for 1M context" 429 body. Disabling 1M context does NOT
      // fix a credential-type credits gate (2026-06-24 incident) — the real
      // recovery is reconnecting the Claude subscription via the in-app
      // OAuth. Surface the reconnect bubble + flag the credential so
      // Profile › Agents shows the reconnect CTA, mirroring the auth path.
      await streaming.closeWithBubble(ONE_M_CREDITS_MESSAGE);
      history.appendAgentReply(ONE_M_CREDITS_MESSAGE);
      void history.flush();
      turnFiles.flushTurn().catch((err) => {
        log.warn('acpRunner', `turnFiles.flushTurn failed: ${describeError(err)}`);
      });
      void reportCredentialInvalid(opts);
      log.info('acpRunner', `start_task ← 1m-credits-reconnect id=${cmd.id.slice(0, 8)}`);
      await relay.sendResult(cmd.id, 'failed', {
        error: 'agent reply reported 1M-context usage-credits gate',
      });
    } else {
      await streaming.closeTurnWithInteractiveDetection();
      const replyLine = formatAgentReplyLine(finalText);
      if (replyLine.length > 0) {
        showInfo(replyLine);
      }
      history.appendAgentReply(finalText);
      void history.flush();
      // Emit static quick-reply chips so the mobile UI has
      // one-tap continuation prompts after every ACP turn.
      // PTY agents emit a single-string `input_suggestion` via
      // OutputService.tick(); ACP has no idle-prompt detector so
      // we emit a fixed array instead. The mobile store normalises
      // both shapes to string[] before rendering.
      // Only emitted on a normal (non-select-prompt) turn end --
      // select_prompt is handled by closeTurnWithInteractiveDetection.
      void publisher.publishOutput({
        type: 'input_suggestion',
        content: ACP_QUICK_REPLIES,
        done: true,
      });
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
    }
  } catch (err) {
    // Whether the turn streamed any assistant text BEFORE recover resets
    // it. When it did, `closeAll` already published that partial reply as
    // the terminal frame — we must NOT clobber it. When it didn't, the only
    // frame is an empty `done:true` (dropped by the mobile snapshot-guard),
    // so we MUST synthesize a visible failure bubble below.
    const hadText = streaming.getCurrentText().trim().length > 0;
    const detail = describeError(err);
    log.warn('acpRunner', `prompt failed: ${detail}`);
    // CANCEL the adapter's stuck turn now (the `promptQueueing` poison),
    // but DEFER the chat flush: we don't yet know whether an ACTIONABLE
    // bubble will REPLACE the streamed text or whether a partial reply must
    // be preserved. Finalising via `closeAll` first commits the streamed
    // raw text (e.g. the agent's own "…401 Invalid authentication
    // credentials") as its OWN terminal `done:true` bubble — and the
    // replacement frame published afterwards can no longer overwrite a
    // finalised turn, so it lands as a SECOND bubble and the raw error
    // stays pinned above the actionable one (the bug this fixes). The flush
    // happens below, routed by the bubble decision: `closeWithBubble`
    // (replace) for an actionable bubble, `closeAll` (keep partial) for a
    // generic streamed-text failure.
    await cancelStuckTurn(client);
    // GUARANTEE a visible terminal frame: recoverFromFailedTurn's closeAll
    // only published the accumulated ASSISTANT text — empty on a first-turn
    // proxy/network/auth failure, which the mobile snapshot-guard drops,
    // leaving the chat with no reply AND no error. failureBubble() decides
    // the actionable message (re-auth, or generic retry when no text
    // streamed); null only when a partial reply already serves as terminal.
    // The outage bubble is shown ONLY when the agent's OWN error
    // indicates a provider overload (`looksLikeProviderOutage` inside
    // failureBubble). We deliberately do NOT consult the provider's
    // status page as a catch-all: a status-page incident can be live
    // while THIS user's local agent is still operational (a partial /
    // regional degradation, or a stale/unrelated advisory like a model
    // suspension). Blaming the provider for a failure it didn't cause —
    // or worse, on a turn that merely failed for an unrelated reason —
    // is a false "service disruption" wall. The error text is the only
    // trustworthy signal that the provider actually rejected the call.
    //
    // Headroom budget-exceeded 429 — checked BEFORE the 1M gate because
    // both are 429s and the discriminator is the proxy's exact body.
    // The proxy is local; the agent provider is healthy. Fire the backend
    // notification once per session (idempotency is the backend's job);
    // then offer the two-option tappable recovery.
    if (looksLikeBudgetExceeded(`${detail}\n${recentStderr.join('\n')}`)) {
      await streaming.closeAll();
      if (!budgetReachedFlag.get()) {
        budgetReachedFlag.set(true);
        void postBudgetReached({
          sessionId: opts.sessionId,
          pluginId: opts.pluginId,
          pluginAuthToken: opts.pluginAuthToken,
          agent: opts.agent,
          period: extractBudgetPeriod(`${detail}\n${recentStderr.join('\n')}`),
        });
      }
      await budgetRecovery.offer(cmd.id, blocks, `${detail}\n${recentStderr.join('\n')}`);
      return;
    }
    // 1M-context usage-credits gate (Rafael 2026-06-24) is classified by
    // failureBubble → ONE_M_CREDITS_MESSAGE (reconnect the Claude
    // subscription). Disabling 1M doesn't fix a credential-type credits
    // gate, so we no longer offer the disable action.
    const bubble = failureBubble({
      detail,
      recentStderr: recentStderr.join('\n'),
      hadText,
      agent: opts.agent,
    });
    if (bubble) {
      // REPLACE the streamed text with the actionable bubble as the SINGLE
      // terminal frame. `closeWithBubble` sets the in-flight text to '' and
      // publishes one `{type:'text', content:bubble, done:true}`; because the
      // streamed bubble is still in `streaming` state (we did NOT closeAll
      // above), mobile's processChunk overwrites it in place instead of
      // pinning the raw error and appending a second bubble. Also neutralises
      // the open streaming-chunk buffers so the raw text doesn't linger on
      // the SessionDetail activity feed.
      await streaming.closeWithBubble(bubble);
      // Persist it in the DURABLE conversation (the output stream is just a
      // 3-min buffer the next turn's `clear` wipes — and mobile re-fetches
      // `get_conversation` on a loop). Without this the bubble shows live
      // then disappears on the next refresh.
      history.appendAgentReply(bubble);
      void history.flush();
    } else {
      // No actionable bubble — a genuine partial reply already streamed and
      // serves as the terminal frame. Finalise it (closeAll) so the
      // streamed text flips out of "Thinking…" without being clobbered.
      await streaming.closeAll();
    }
    if (bubble === AUTH_FAILURE_MESSAGE || bubble === ONE_M_CREDITS_MESSAGE) {
      // Same durable flag as onUnexpectedExit — covers the case where the
      // adapter 401s mid-turn (stalls → idle timeout) instead of exiting,
      // so Profile › Agents still surfaces the re-auth/reconnect CTA rather
      // than leaving the user stuck on a CONNECTED-but-dead credential. The
      // 1M-credits gate reuses this to drive the subscription-reconnect CTA.
      void reportCredentialInvalid(opts);
    }
    await relay.sendResult(cmd.id, 'failed', { error: detail });
  }
  return;
}

async function groupMentionTaskH(ctx: AcpCommandContext): Promise<void> {
  const { cmd, client, relay, streaming, opts, history } = ctx;
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

async function stopTaskH(ctx: AcpCommandContext): Promise<void> {
  const { cmd, client, relay, streaming } = ctx;
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

async function getConversationH(ctx: AcpCommandContext): Promise<void> {
  const { cmd, relay, acpSessionId, jsonlHistory } = ctx;
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

async function listModelsH(ctx: AcpCommandContext): Promise<void> {
  const { cmd, relay, models } = ctx;
  await relay.sendResult(cmd.id, 'completed', { models });
  return;
}

async function ackEmptyH(ctx: AcpCommandContext): Promise<void> {
  const { cmd, relay } = ctx;
  // Codespace-only / not-applicable in ACP mode. Ack as completed
  // with an empty result so mobile's optional features degrade
  // silently instead of showing a permanent "loading" spinner.
  await relay.sendResult(cmd.id, 'completed', {});
  return;
}

async function selectOptionH(ctx: AcpCommandContext): Promise<void> {
  const { cmd, client, relay, streaming, history, oneMRecovery, budgetRecovery } = ctx;
  // On-demand 1M-context recovery: if THIS select is the
  // "Disable 1M context and continue" action we offered after a 1M-credits
  // 429, handle it locally (disable + re-spawn + re-run the failed prompt)
  // — never route it into the agent's resolveSelection.
  if (await oneMRecovery.tryRecover(cmd.id)) return;
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
  // On-demand Headroom budget-exceeded recovery: if THIS select is a
  // "Pause budget this session" or "Raise budget" action we offered
  // after a budget 429, handle it locally — never route into resolveSelection.
  if (await budgetRecovery.tryRecover(cmd.id, absoluteIndex)) return;
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
  // NOTE: the original switch case had a trailing `return;` here — dead code
  // (the inner switch above is exhaustive), flagged by TS as "Unreachable
  // code detected". Deleted during the Phase 3 extraction.
}

async function provideInputH(ctx: AcpCommandContext): Promise<void> {
  const { cmd, client, relay, streaming, history, turnFiles } = ctx;
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

async function resumeSessionH(ctx: AcpCommandContext): Promise<void> {
  const { cmd, client, relay, opts, agentCaps } = ctx;
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

async function changeModelH(ctx: AcpCommandContext): Promise<void> {
  const { cmd, client, relay, opts } = ctx;
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

async function summarizeH(ctx: AcpCommandContext): Promise<void> {
  const { cmd, client, relay, streaming, history, turnFiles } = ctx;
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

async function sessionShutdownH(ctx: AcpCommandContext): Promise<void> {
  const { cmd, client, relay, opts } = ctx;
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
  // NOTE: the original switch case had a trailing `return;` here — dead code
  // (process.exit never returns), flagged by TS as "Unreachable code
  // detected". Deleted during the Phase 3 extraction.
}

async function previewH(ctx: AcpCommandContext): Promise<void> {
  const { cmd, relay, opts } = ctx;
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
  const legacyCtx = buildLegacyContextForACP(opts, ackingRelay, runtime);
  try {
    await legacyDispatchCommand(legacyCtx, cmd);
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

async function legacyOrUnsupportedH(ctx: AcpCommandContext): Promise<void> {
  const { cmd, relay, opts } = ctx;
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

/**
 * Dispatch table — one entry per explicitly-handled relay command type.
 * Aliased types (stop_task/escape_key, set_keep_alive/get_context,
 * session_terminated/shutdown_session, the preview family) share one handler,
 * exactly as their switch cases shared a body/fall-through before.
 */
export const ACP_COMMAND_HANDLERS: Record<string, AcpCommandHandler> = {
  beads_action: beadsActionH,
  start_task: startTaskH,
  group_mention_task: groupMentionTaskH,
  stop_task: stopTaskH,
  escape_key: stopTaskH,
  get_conversation: getConversationH,
  list_models: listModelsH,
  set_keep_alive: ackEmptyH,
  get_context: ackEmptyH,
  select_option: selectOptionH,
  provide_input: provideInputH,
  resume_session: resumeSessionH,
  change_model: changeModelH,
  summarize: summarizeH,
  session_terminated: sessionShutdownH,
  shutdown_session: sessionShutdownH,
  request_preview_detect: previewH,
  preview_start: previewH,
  preview_stop: previewH,
  save_preview_config: previewH,
};

/**
 * Map a relay command to the ACP equivalent.
 *
 * Every handler MUST call `relay.sendResult(cmd.id, status, result)`
 * exactly once. Without an ack the backend keeps the command in
 * "pending" and mobile's auto-refresh loops (notably
 * `get_conversation` every ~20 s) retry forever — manifests as the
 * mobile chat sitting empty while the CLI looks like it's hung.
 */
export async function dispatchAcpCommand(ctx: AcpCommandContext): Promise<void> {
  const handler = ACP_COMMAND_HANDLERS[ctx.cmd.type];
  if (handler) {
    await handler(ctx);
    return;
  }
  await legacyOrUnsupportedH(ctx);
}
