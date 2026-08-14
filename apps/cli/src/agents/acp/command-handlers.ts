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
import { resolveApiBaseUrl } from '@codeam/shared';
import { showInfo } from '../../ui/banner';
import { createOsStrategy } from '../../os';
import { createInteractiveAgentStrategy } from '../registry';
import { modeIsFullAutoApprove } from './modes';
// Re-exported for back-compat: the set-mode auto-approve spec imports it from here.
export { modeIsFullAutoApprove } from './modes';
import type { RuntimeStrategy } from '../strategy';
import { removeSession, setSquadAuto } from '../../config';
import { closeAllTerminals } from '../../services/terminal-ops.service';
import type { CommandRelayService, RemoteCommand } from '../../services/command-relay.service';
import type { HistoryService } from '../../services/history.service';
import type { TurnFileAggregator } from '../../services/turn-files/turn-file-aggregator';
import { beadsActionFromPayload } from '../../beads/wiring';
import { handleBeadsActionCommand, type StartedBeads } from '../../beads';
import { configureSkill, type SkillsConfigureAction } from '../../skills/configure';
import { packStartH, packActionH, packStatusH } from '../../packs/handlers';
import { persistIntegrationsManifest, readIntegrationsManifest } from '../../integrations/manifest';
import { buildMcpServersForStart } from '../../integrations/provision';
import { detectRepoStack } from '../../integrations/detect-stack';
import {
  SQUAD_CONFIGURE_COMMAND,
  SQUAD_STATS_COMMAND,
  clampHopBudget,
  type HandoffProposal,
  type HandoffResolution,
  type IntegrationsManifest,
  type SquadConfigurePayload,
  type SquadConfigureResult,
  type SquadStatsResult,
  type StartTaskPayload,
} from '@codeam/shared';
import { buildDeltaBriefing, buildTeamPreamble, type SquadState } from './squad-roster';
import {
  buildSquadContextBlock,
  isSquadContextBlock,
  looksLikeUnsupportedPromptShape,
} from './squad-context';
import { extractHandoffProposal } from './handoff-protocol';
import type { PromptResponse } from '@agentclientprotocol/sdk';
import { execFile } from 'node:child_process';
import {
  handlers as legacyHandlers,
  dispatchCommand as legacyDispatchCommand,
  type BaseHandlerContext,
} from '../../commands/start/handlers';
import type { AcpClient } from './client';
import type { AcpPublisher } from './publisher';
import { buildAcpPromptBlocks, type PromptBlock } from './buildAcpPromptBlocks';
import { maybePrefaceAgentStandard } from '../agent-standard';
import { shouldOfferOneMRecovery } from './oneMContextRecovery';
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
  houseAgentLimitMessage,
  replyIsAuthFailure,
  replyIsHouseAgentLimit,
} from './failure-messages';
import { agentHooks } from './agent-hooks';
import { postBudgetReached, reportCredentialInvalid } from './backend-reports';
import type { AcpHistory, AcpRunnerOptions, StreamingState } from './runner';

/**
 * The session-scoped half of {@link AcpCommandContext} — every field that is
 * fixed for the lifetime of one ACP session (the client, publisher, streaming
 * state, history, models, …). Assembled ONCE per session by the owner of the
 * ACP machinery (`runAcpSession` for cloud/self-hosted, {@link
 * AcpDriver} for the local baton) and combined with the incoming `cmd` via
 * {@link assembleAcpCommandContext} on every command. Splitting it out lets both
 * owners build the exact same context shape without duplicating the field list.
 */
export interface AcpSessionContext {
  client: AcpClient;
  relay: CommandRelayService;
  acpSessionId: string;
  streaming: StreamingState;
  opts: AcpRunnerOptions;
  history: AcpHistory;
  jsonlHistory: HistoryService;
  agentCaps: { loadSession?: boolean } | undefined;
  turnFiles: TurnFileAggregator;
  getBeads: () => StartedBeads | null;
  publisher: AcpPublisher;
  recentStderr: string[];
  /** On-demand Headroom budget-exceeded recovery (offer pause/raise options). */
  budgetRecovery: BudgetRecovery<PromptBlock>;
  /** Fire-once guard for the budget-reached backend POST. */
  budgetReachedFlag: { get: () => boolean; set: (v: boolean) => void };
  /**
   * Invoked by `resume_session` after a successful loadSession so the OWNER
   * of the session machinery re-points its active-conversation id — the
   * runner's `acpSessionId` binding feeds every FUTURE command context
   * (`get_conversation` acks, transcript uploads, one-shots). Without it a
   * resumed session kept acking the OLD conversation id and mobile loaded
   * the wrong history forever (2026-07-16). Optional: the baton AcpDriver
   * owns its ids differently and may not wire it.
   */
  onActiveSessionChanged?: (id: string) => void;
  /**
   * In-session agent switch — the runner-owned orchestration
   * (`performAgentSwitch` wired over its swappable locals). Absent on the
   * baton AcpDriver (local TUI sessions can't swap agents) → the
   * `switch_agent` handler acks an honest "not supported here" failure.
   */
  switchAgent?: (agentId: unknown) => Promise<import('@codeam/shared').SwitchAgentResult>;
  /**
   * Context-handoff slot: the switch stores the OLD conversation's bounded
   * tail here; `start_task` prefixes it to the FIRST post-switch prompt and
   * clears it, so the new agent inherits the session's context.
   */
  pendingHandoff?: { current: string | null };
  // ─── Agent Squad (all optional — the baton AcpDriver omits them, exactly
  //     like `switchAgent`, and every squad feature degrades to a no-op) ────
  /** Roster + per-member provisioning state + the shared turn journal. */
  squad?: SquadState;
  /**
   * Roster-aware @-mention routing: swap onto `agentId` for THIS task
   * (fast path for a member this process already brought up; per-agent
   * conversation resume when the member has its own transcript).
   * `skipFastPath` forces the full credential/install sequence — the ONE
   * retry after a fast-path failure (an expired credential).
   *
   * ⚠️ Returns the runner's POST-SWAP {@link AcpSessionHandles} alongside the
   * result — see {@link SquadRouteOutcome} for why the caller MUST rebind.
   */
  routeToAgent?: (agentId: string, opts?: { skipFastPath?: boolean }) => Promise<SquadRouteOutcome>;
  /** At most ONE un-resolved agent-proposed handoff at a time. */
  pendingProposal?: { current: HandoffProposal | null };
  /** Serialized emitter — the SAME chain the switch events ride, so a
   *  `handoff_resolved` can never overtake the swap that resolved it. */
  postSquadEvent?: (
    type: 'handoff_proposed' | 'handoff_resolved',
    payload: Record<string, unknown>,
  ) => Promise<unknown>;
}

/**
 * The session handles an agent swap REPLACES. `relaunchWith` stops the old
 * adapter (which nulls its connection + session id) and reassigns the runner's
 * swappable `let`s — but an {@link AcpCommandContext} is a plain `{...session,
 * cmd}` SNAPSHOT taken before the command ran, so a handler that swapped
 * mid-command still holds the DEAD ones. Every one of these must be rebound
 * after a successful route or the turn runs against a stopped client
 * ("AcpClient.prompt called before start()"), writes history into a discarded
 * accumulator, and loses the freshly-built handoff preamble.
 */
export type AcpSessionHandles = Pick<
  AcpSessionContext,
  'client' | 'acpSessionId' | 'history' | 'jsonlHistory' | 'agentCaps' | 'budgetRecovery'
>;

/**
 * Result of a squad route: the switch outcome PLUS the post-swap handles the
 * caller must rebind onto its context. `handles` is returned on FAILURE too —
 * a failed swap runs the revert, which relaunches the prior agent and
 * therefore replaces the same handles.
 */
export interface SquadRouteOutcome {
  result: import('@codeam/shared').SwitchAgentResult;
  handles: AcpSessionHandles;
}

/**
 * Everything a relayed command needs to execute against the live ACP session:
 * the {@link AcpSessionContext} plus the specific `cmd` being handled. Built per
 * command via {@link assembleAcpCommandContext} — one flat bag instead of the
 * previous 19 positional parameters.
 */
export type AcpCommandContext = AcpSessionContext & { cmd: RemoteCommand };

/**
 * Combine the session-scoped context with a single incoming command into the
 * per-command {@link AcpCommandContext}. The ONE place the two halves are joined,
 * so `runAcpSession` and the baton {@link AcpDriver} assemble identical contexts.
 */
export function assembleAcpCommandContext(
  session: AcpSessionContext,
  cmd: RemoteCommand,
): AcpCommandContext {
  return { ...session, cmd };
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
 * For ACP we reuse the agent-AGNOSTIC ones (preview flow, file ops, git ops,
 * terminal ops, etc.) without re-implementing them. Those handlers read only
 * {@link BaseHandlerContext} fields, so this returns exactly that — no PTY
 * machinery, no `as unknown as` cast fabricating fields we don't own. The full
 * `HandlerContext` narrowing happens once, at `dispatchCommand`'s handler-
 * invocation boundary (which documents why it's sound for base-only callers).
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
): BaseHandlerContext {
  return {
    runtime,
    relay,
    pluginId: opts.pluginId,
    sessionId: opts.sessionId,
    // The running ACP agent (claude/codex/gemini/cursor). REQUIRED: headroom_configure
    // resolves the agent from ctx.agentId; without it the enable gate sees '' and
    // returns {supported:false} for a real Claude session.
    agentId: opts.agent,
    pluginAuthToken: opts.pluginAuthToken,
  };
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

// ─── Agent Squad helpers (start_task routing / prefixes / journal) ─────────

/**
 * Swap the live session onto the @-mentioned squad member before its task
 * runs. Refuses honestly instead of silently answering with the WRONG agent —
 * a mention that lands on the current agent is the caller's business (no-op).
 *
 * A fast-path swap (member already provisioned + binary-verified THIS process)
 * can fail on a credential that expired since then; that is retried ONCE on
 * the full path. A first attempt that already ran the full sequence is NOT
 * retried — an identical second attempt only costs another adapter restart
 * (and another revert) for the same failure.
 */
/**
 * Point the live command context at the post-swap session handles. The
 * context is a snapshot, so this is the ONLY thing that keeps a routed turn
 * talking to the agent that is actually running (see {@link AcpSessionHandles}).
 */
function rebindSessionHandles(
  ctx: AcpCommandContext,
  outcome: SquadRouteOutcome,
): SquadRouteOutcome {
  Object.assign(ctx, outcome.handles);
  return outcome;
}

async function routeSquadTask(
  ctx: AcpCommandContext,
  target: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { squad, routeToAgent } = ctx;
  if (!routeToAgent) {
    return { ok: false, error: 'Routing to another agent is not supported on this session.' };
  }
  // The roster is the authority on membership when we have one. Without it
  // (old backend / offline) `performAgentSwitch`'s own validation still
  // rejects unknown / non-switchable ids honestly.
  const roster = squad?.roster;
  if (roster && !roster.agents.some((a) => a.agentId === target)) {
    return { ok: false, error: `Unknown agent '${target}' — not in your squad.` };
  }
  const member = squad?.member(target);
  const fastPathArmed = Boolean(member && (member.provisioned || member.binaryVerified));
  // REBIND after every attempt (including failures — the revert relaunches the
  // prior agent, replacing the same handles). Without this the rest of the
  // command runs against the client the swap already stopped.
  let { result } = rebindSessionHandles(ctx, await routeToAgent(target));
  if (!result.ok && fastPathArmed) {
    log.warn(
      'acpRunner',
      `squad: fast-path route to ${target} failed (${result.error}) — retrying full path`,
    );
    ({ result } = rebindSessionHandles(ctx, await routeToAgent(target, { skipFastPath: true })));
  }
  if (!result.ok) {
    // `SwitchAgentResult.error` is optional on the wire type; every failure
    // path in performAgentSwitch sets it, so the fallback is belt-and-braces
    // against an empty ack the mobile would render as a blank error.
    return { ok: false, error: result.error ?? `Couldn't switch to ${target}.` };
  }
  return { ok: true };
}

/**
 * Collect the squad context pieces for THIS turn, in the order the agent reads
 * them: `[team preamble?, delta briefing?, pending handoff?]`. Each piece is
 * conditional:
 *
 *  - **team preamble** — once per member, on its FIRST turn this process
 *    (`lastTurnIndex === 0`); tells it who else is on the squad and, when the
 *    plan allows, how to propose a handoff.
 *  - **delta briefing** — only when OTHER agents journaled turns this member
 *    hasn't seen (`turnCount() > lastTurnIndex`).
 *  - **pending handoff** — the existing switch mechanism (one-shot).
 *
 * Consumes the one-shot handoff slot, so it must be called exactly once per
 * turn. All of it rides the AGENT prompt only: the recorded/echoed user prompt
 * stays the user's own words.
 */
function collectSquadContext(ctx: AcpCommandContext): string[] {
  const pieces: string[] = [];
  const { squad, opts } = ctx;
  if (squad) {
    const member = squad.member(opts.agent);
    const roster = squad.roster;
    if (roster && member.lastTurnIndex === 0) {
      const preamble = buildTeamPreamble(roster, opts.agent, {
        handoffInstructions: roster.handoffsEnabled === true,
      });
      if (preamble) pieces.push(preamble);
    }
    if (squad.turnCount() > member.lastTurnIndex) {
      // Exclude this agent's OWN prior turns — after a CLI restart lastTurnIndex
      // resets to 0 while the journal persists, so without this filter an agent
      // gets briefed on work it already did itself.
      const otherEntries = squad
        .entriesSince(member.lastTurnIndex)
        .filter((e) => e.agentId !== opts.agent);
      const briefing = buildDeltaBriefing(otherEntries);
      if (briefing) pieces.push(briefing);
    }
  }
  if (ctx.pendingHandoff?.current) {
    pieces.push(ctx.pendingHandoff.current);
    ctx.pendingHandoff.current = null;
  }
  return pieces;
}

/**
 * Prepend the collected squad context onto the prompt blocks.
 *
 * **NATIVE by default:** ONE `ContentBlock::Resource` carrying all the pieces
 * joined — semantically context, never user words, so the agent's own JSONL
 * doesn't record it as part of the user's message and the hydration path can't
 * replay it as a visible bubble (the P0 the addendum fixes). `text` mode is
 * the per-agent fallback for an adapter that rejects resource blocks; it
 * reproduces the pre-fix layout (one text block per piece).
 */
/** Native resource delivery unless THIS agent's adapter already rejected it. */
function squadContextMode(ctx: AcpCommandContext): 'resource' | 'text' {
  return ctx.squad?.member(ctx.opts.agent).contextTextFallback === true ? 'text' : 'resource';
}

function applySquadContext(
  blocks: PromptBlock[],
  pieces: readonly string[],
  mode: 'resource' | 'text',
): void {
  if (pieces.length === 0) return;
  if (mode === 'resource') {
    blocks.unshift(buildSquadContextBlock(pieces.join('\n\n')));
    return;
  }
  for (let i = pieces.length - 1; i >= 0; i--) blocks.unshift({ type: 'text', text: pieces[i] });
}

/**
 * Run the turn's prompt, with a ONE-shot per-agent downgrade to legacy text
 * blocks when the adapter can't accept the native resource block.
 *
 * The retry is gated on {@link looksLikeUnsupportedPromptShape} (an
 * invalid-params-shaped rejection) — anything else propagates untouched, so a
 * genuinely failed turn is never silently re-run. The decision is remembered
 * on the squad member so the rest of the session goes straight to text.
 * `blocks` is mutated in place: downstream consumers (budget recovery) must
 * see the array the agent actually received.
 */
async function promptWithContextFallback(
  ctx: AcpCommandContext,
  client: AcpClient,
  blocks: PromptBlock[],
  pieces: readonly string[],
): Promise<PromptResponse> {
  try {
    return await client.prompt(blocks);
  } catch (err) {
    if (
      pieces.length === 0 ||
      blocks.length === 0 ||
      !isSquadContextBlock(blocks[0]) ||
      !looksLikeUnsupportedPromptShape(err)
    ) {
      throw err;
    }
    log.warn(
      'acpRunner',
      `squad: ${ctx.opts.agent} rejected the native squad-context resource block ` +
        `(${describeError(err)}) — retrying once with legacy text blocks`,
    );
    if (ctx.squad) ctx.squad.member(ctx.opts.agent).contextTextFallback = true;
    blocks.shift();
    applySquadContext(blocks, pieces, 'text');
    return await client.prompt(blocks);
  }
}

/**
 * Append the finished turn to the squad journal so the NEXT agent to take
 * over gets it in its delta briefing. Order matters: record first, THEN
 * advance this agent's `lastTurnIndex` to the new turn count — otherwise the
 * agent would be briefed on its own turn.
 */
function recordSquadTurn(ctx: AcpCommandContext, prompt: string, replySummary: string): void {
  const { squad, opts, turnFiles } = ctx;
  if (!squad) return;
  squad.recordTurn({
    agentId: opts.agent,
    prompt,
    replySummary,
    // TurnFileAggregator owns per-turn file changesets end-to-end (git diff →
    // outbox POST). The caller (`startTaskH`) AWAITS `turnFiles.flushTurn()`
    // for THIS turn before calling recordSquadTurn precisely so
    // `peekTurnPaths()` reflects THIS turn's novel files, not a stale read
    // of whatever the aggregator's PREVIOUS flush happened to find. Capped
    // so a pathological turn (mass refactor) doesn't bloat the journal.
    filesTouched: turnFiles.peekTurnPaths().slice(0, 20),
  });
  squad.member(opts.agent).lastTurnIndex = squad.turnCount();
}

/**
 * Squad ids a handoff may be proposed TO: every roster member except the one
 * replying. Empty without a roster — `extractHandoffProposal` then still
 * STRIPS the fence (protocol litter never reaches the user) but yields no
 * proposal.
 */
function handoffTargets(ctx: AcpCommandContext): Set<string> {
  const roster = ctx.squad?.roster;
  if (!roster) return new Set();
  return new Set(roster.agents.map((a) => a.agentId).filter((id) => id !== ctx.opts.agent));
}

/**
 * Resolve the open agent-proposed handoff, if any, against the task the user
 * just sent: routing the task to the proposed agent ACCEPTS it, anything else
 * (a different agent, or just carrying on with the current one) DECLINES it.
 * The slot clears either way — a proposal is only ever answered once, and an
 * un-answered one must never outlive the turn that followed it.
 */
function resolvePendingProposal(ctx: AcpCommandContext, requestedAgentId: string): void {
  const slot = ctx.pendingProposal;
  const pending = slot?.current;
  if (!slot || !pending) return;
  slot.current = null;
  const accepted = requestedAgentId === pending.toAgentId;
  if (accepted) ctx.squad?.countAccepted();
  log.info(
    'acpRunner',
    `squad: handoff ${pending.proposalId} ${accepted ? 'accepted' : 'declined'}`,
  );
  const resolution: HandoffResolution = { proposalId: pending.proposalId, accepted };
  void ctx.postSquadEvent?.('handoff_resolved', { ...resolution });
}

/**
 * `proposalId` for a proposal raised on hop `hop` of this command's chain.
 * Derived from the command id + hop index, so it is stable and collision-free
 * WITHOUT a clock (a retried ack for the same turn resolves the same
 * proposal). Bounded at 128 chars — the wire field's ceiling.
 */
function proposalIdFor(commandId: string, hop: number): string {
  const id = hop <= 1 ? `hp-${commandId}` : `hp-${commandId}-h${hop}`;
  return id.length > 128 ? id.slice(0, 128) : id;
}

/**
 * Publish an agent-proposed handoff the reply carried in its
 * ```codeam-handoff fence. Gated on the PRO roster flag (`handoffsEnabled`)
 * and capped at ONE open proposal — a second one while the first is
 * un-resolved is dropped rather than racing two cards onto the app.
 *
 * **Autonomous mode (P2-2):** when the session opted in AND the chain has hops
 * left, the proposal is SELF-ACCEPTED instead of carded — `handoff_proposed`
 * carries `auto: true` + `hopsRemaining`, `handoff_resolved` follows
 * immediately with `accepted: true, auto: true`, and the record is RETURNED so
 * the caller runs it as the next turn. The slot is deliberately left empty in
 * that case: there is no card for the user to answer. Returns `null` for the
 * normal card flow (and for no proposal at all).
 */
function emitHandoffProposal(
  ctx: AcpCommandContext,
  proposal: { to: string; reason: string; prompt: string } | null,
  hop: number,
): HandoffProposal | null {
  const { squad, pendingProposal, postSquadEvent, opts, cmd } = ctx;
  if (!proposal || !pendingProposal || !postSquadEvent) return null;
  if (squad?.roster?.handoffsEnabled !== true) return null;
  if (pendingProposal.current) {
    log.info('acpRunner', 'squad: dropping handoff proposal — one is already pending');
    return null;
  }
  // Budget exhausted (or auto off) → the v1 card flow, untouched.
  const auto = squad.auto.enabled && squad.hopsRemaining() > 0;
  const record: HandoffProposal = {
    proposalId: proposalIdFor(cmd.id, hop),
    fromAgentId: opts.agent,
    toAgentId: proposal.to,
    reason: proposal.reason,
    prompt: proposal.prompt,
    ...(auto ? { auto: true, hopsRemaining: squad.hopsRemaining() } : {}),
  };
  squad.countProposal({ auto });
  log.info(
    'acpRunner',
    `squad: handoff proposed ${opts.agent} → ${record.toAgentId}${auto ? ' (auto)' : ''}`,
  );
  void postSquadEvent('handoff_proposed', { ...record });
  if (!auto) {
    pendingProposal.current = record;
    return null;
  }
  squad.consumeHop();
  squad.countAccepted();
  const resolution: HandoffResolution = {
    proposalId: record.proposalId,
    accepted: true,
    auto: true,
  };
  void postSquadEvent('handoff_resolved', { ...resolution });
  return record;
}

async function startTaskH(ctx: AcpCommandContext): Promise<void> {
  // Only the handles a swap can NEVER replace are destructured up front —
  // `relaunchWith` reassigns client / history / jsonlHistory / agentCaps /
  // budgetRecovery, so those are read from `ctx` AFTER the routing block below
  // (see {@link AcpSessionHandles}); destructuring them here would pin this
  // turn to the adapter the swap just stopped.
  const { cmd, relay, streaming, opts, turnFiles, publisher, recentStderr, budgetReachedFlag } =
    ctx;
  const payload = cmd.payload as StartTaskPayload | undefined;
  const blocks = buildAcpPromptBlocks(payload ?? {});
  if (blocks.length === 0) {
    log.warn('acpRunner', 'start_task with empty prompt + no attachments; ignoring');
    await relay.sendResult(cmd.id, 'failed', { error: 'empty prompt' });
    return;
  }
  // Agent Squad @-mention routing: the task carries the MENTIONED agent's id.
  // Swap onto it BEFORE anything else runs — a failed swap fails the TASK
  // (never silently answers with the agent the user didn't mention). An id
  // equal to the current agent (or absent) is a plain no-op: run as normal.
  const requestedAgentId = typeof payload?.agentId === 'string' ? payload.agentId.trim() : '';
  // An open agent-proposed handoff is answered by THIS task: routing it to the
  // proposed agent accepts, anything else declines. Runs before the routing so
  // the resolution reflects what the user actually asked for.
  resolvePendingProposal(ctx, requestedAgentId);
  if (requestedAgentId.length > 0 && requestedAgentId !== opts.agent) {
    const routed = await routeSquadTask(ctx, requestedAgentId);
    if (!routed.ok) {
      log.warn('acpRunner', `start_task routing to ${requestedAgentId} failed: ${routed.error}`);
      await relay.sendResult(cmd.id, 'failed', { error: routed.error });
      return;
    }
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
  // Post-routing handles: on a routed turn `ctx` was rebound to the NEW
  // agent's client/history by the routing block above, so every handle is read
  // from `ctx` (never destructured before the swap could replace it).
  ctx.history.appendUserPrompt(promptText);
  // Non-Claude ACP agents get the always-on Agent Standard as a one-time preface
  // on the first turn of a new conversation (Claude gets it via ~/.claude/CLAUDE.md).
  // Prepended AFTER recording the user prompt + echo, so it rides the agent prompt
  // only and never shows as part of the user's message. Managed deploys only.
  maybePrefaceAgentStandard(blocks, opts.agent, opts.sessionId);
  // Squad context, composed onto the AGENT prompt only, as ONE native ACP
  // resource block ahead of the user's blocks:
  //   [codeam://squad-context {preamble?, briefing?, handoff?}, ...user blocks]
  // The handoff piece is the existing `switch_agent` continuity mechanism — the
  // FIRST prompt after a swap carries the OLD conversation's bounded tail so
  // the new agent continues with the session's context instead of starting
  // cold (one-shot). Delivered as a resource (not text) so it never lands in
  // the agent's JSONL as user words — see `squad-context.ts`.
  const squadContext = collectSquadContext(ctx);
  applySquadContext(blocks, squadContext, squadContextMode(ctx));
  // A USER-initiated prompt always re-arms the autonomous-handoff chain: it
  // interrupts whatever chain was running and gives the new work a full budget.
  ctx.squad?.resetHops();
  // ── Autonomous handoff chain (P2-2) ──────────────────────────────────────
  // Each iteration is ONE agent turn. A self-accepted handoff (auto mode, PRO,
  // budget left) routes to the target and loops with the proposal's prompt as
  // the next turn; everything else acks and returns. The hop budget is the hard
  // bound — there is no other exit condition on the chain.
  let turnBlocks = blocks;
  let turnPieces = squadContext;
  let turnPrompt = promptText;
  let hop = 1;
  for (;;) {
    // Re-read on EVERY iteration: an auto hop swaps the agent, which replaces
    // these handles exactly like the @-mention route does.
    const { client, history, budgetRecovery } = ctx;
    // Tracks whether the turn already reached a terminal, VISIBLE close (reply
    // delivered + "Thinking…" cleared). Once true, the only awaited work left is
    // the command ACK — and a long (>10 min) turn's `command:<id>` record can
    // expire on the backend (COMMAND_TTL) so `sendResult` 404s. That POST-CLOSE
    // ack failure must NOT be caught and turned into a "couldn't finish" bubble
    // that CLOBBERS the already-delivered reply (2026-08-04, codeagent-dtz7).
    let turnClosed = false;
    try {
      const reply = await promptWithContextFallback(ctx, client, turnBlocks, turnPieces);
      // Close with interactive-detection so a trailing
      // "question + numbered options" pattern in the reply gets
      // surfaced as a tappable select_prompt chunk on mobile
      // instead of staying as plain text (Gemini's typical shape
      // for "¿continuar? 1. sí 2. no").
      const finalText = streaming.getCurrentText();
      if (agentHooks(opts.agent)?.classifyCompletedReply?.(finalText) === 'upgrade_required') {
        // Cursor's OWN plan paywall ("Upgrade your plan to continue"): the
        // user's Cursor account is on Free, which doesn't include the headless
        // Agent. NOT a credential problem — swap the bare text for an
        // actionable bubble linking to the user's Cursor account upgrade page.
        // Do NOT reportCredentialInvalid (the login is valid).
        await streaming.closeWithBubble(CURSOR_UPGRADE_MESSAGE);
        turnClosed = true;
        history.appendAgentReply(CURSOR_UPGRADE_MESSAGE);
        void history.flush();
        log.info('acpRunner', `start_task ← cursor-plan-upgrade-required id=${cmd.id.slice(0, 8)}`);
        await relay.sendResult(cmd.id, 'failed', { error: 'cursor plan upgrade required' });
        return;
      } else if (replyIsHouseAgentLimit(finalText)) {
        // The turn COMPLETED but the reply IS a house-proxy 403 (CodeAgent Cloud
        // daily usage ceiling / temporarily unavailable). Claude streams the
        // wrapped "Failed to authenticate. API Error: 403 …" as plain reply text,
        // which replyIsAuthFailure would otherwise misclassify as a bad
        // credential → a pointless re-auth loop (2026-07-29 Rafael). It is a
        // usage/availability limit — surface the accurate daily-limit bubble and
        // DO NOT reportCredentialInvalid (the credential, if any, is fine; the
        // house agent has none to renew).
        const houseBubble = houseAgentLimitMessage(finalText);
        await streaming.closeWithBubble(houseBubble);
        turnClosed = true;
        history.appendAgentReply(houseBubble);
        void history.flush();
        turnFiles.flushTurn().catch((err) => {
          log.warn('acpRunner', `turnFiles.flushTurn failed: ${describeError(err)}`);
        });
        log.info('acpRunner', `start_task ← house-agent-limit id=${cmd.id.slice(0, 8)}`);
        await relay.sendResult(cmd.id, 'failed', {
          error: 'house agent usage ceiling / temporarily unavailable',
        });
        return;
      } else if (replyIsAuthFailure(finalText)) {
        // The agent COMPLETED the turn but its reply IS an auth-failure
        // notice ("Not logged in · Please run /login") — a missing/expired
        // credential the agent surfaced as plain text instead of throwing.
        // Swap the raw CLI text for the actionable re-auth bubble and flag
        // the LinkedAgent credential invalid so Profile › Agents shows
        // EXPIRED + the re-link CTA, identical to the throw/exit auth paths.
        await streaming.closeWithBubble(AUTH_FAILURE_MESSAGE);
        turnClosed = true;
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
        return;
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
        turnClosed = true;
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
        return;
      } else {
        await streaming.closeTurnWithInteractiveDetection();
        turnClosed = true;
        // Agent-proposed handoff: the reply may END with a ```codeam-handoff
        // fence. It's protocol litter the app renders as a card — the live +
        // terminal frames already suppress it (StreamingState), and everything
        // DURABLE (terminal echo, conversation history, squad journal) uses the
        // stripped text so it can never resurface on a refresh.
        const { cleanText, proposal } = extractHandoffProposal(
          finalText,
          opts.agent,
          handoffTargets(ctx),
        );
        const replyLine = formatAgentReplyLine(cleanText);
        if (replyLine.length > 0) {
          showInfo(replyLine);
        }
        history.appendAgentReply(cleanText);
        void history.flush();
        // End-of-turn file changeset — agent likely edited files during the
        // turn (tool_call write_file / bash). The aggregator runs git diff
        // once and batch-posts the hunks so mobile's PENDING REVIEW counter +
        // Files rail update. `peekTurnPaths()` (read below by
        // `recordSquadTurn`) only updates INSIDE this call, so a squad
        // session AWAITS it here — small git-diff latency before the ack —
        // so the journal entry captures THIS turn's paths instead of
        // permanently lagging one turn behind. A non-squad session has no
        // journal to feed, so it keeps the original fire-and-forget
        // behavior (`flush` is still `.catch()`'d — no unhandled rejection).
        const flush = turnFiles.flushTurn().catch((err) => {
          log.warn('acpRunner', `turnFiles.flushTurn failed: ${describeError(err)}`);
        });
        if (ctx.squad) await flush;
        // Journal the turn for the squad's shared memory — the NEXT agent to
        // take over receives it in its delta briefing. `opts.agent` is the
        // ROUTED agent here (the swap above already moved it).
        recordSquadTurn(ctx, turnPrompt, cleanText);
        // Autonomous mode self-ACCEPTS a valid proposal instead of emitting the
        // tap-to-accept card: route to the target and run the proposal's prompt
        // as the next iteration of this chain. `null` = the normal card flow (or
        // no proposal at all) — fall through and close the turn.
        const autoHop = emitHandoffProposal(ctx, proposal, hop);
        if (autoHop) {
          const routed = await routeSquadTask(ctx, autoHop.toAgentId);
          if (routed.ok) {
            hop += 1;
            turnPrompt = autoHop.prompt;
            // The routed agent may be new to this session — collect ITS squad
            // context (preamble / briefing) exactly like a user-routed turn.
            turnPieces = collectSquadContext(ctx);
            turnBlocks = [{ type: 'text', text: turnPrompt }];
            // Same one-time preface the @-mention route gives a newly-routed
            // agent (no-op once that agent has had it this session).
            maybePrefaceAgentStandard(turnBlocks, opts.agent, opts.sessionId);
            applySquadContext(turnBlocks, turnPieces, squadContextMode(ctx));
            await streaming.beginTurn();
            ctx.history.appendUserPrompt(turnPrompt);
            continue;
          }
          // The chain stops here rather than wedging: the reply the user already
          // has is real, and the failed swap left the session on its prior agent.
          log.warn(
            'acpRunner',
            `squad: auto-handoff to ${autoHop.toAgentId} failed: ${routed.error}`,
          );
        }
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
        log.info(
          'acpRunner',
          `start_task ← done stopReason=${reply.stopReason ?? '?'} id=${cmd.id.slice(0, 8)}`,
        );
        await relay.sendResult(cmd.id, 'completed', { stopReason: reply.stopReason });
        return;
      }
    } catch (err) {
      // POST-CLOSE ACK GUARD: if the turn already reached a terminal, visible
      // close, the reply was delivered and "Thinking…" cleared — the only awaited
      // work that can throw after that is the command ACK (`sendResult`). On a
      // turn that ran longer than the backend's COMMAND_TTL (10 min), the
      // `command:<id>` record has expired so `sendResult` 404s. Treating that as a
      // turn failure fired the generic "The agent hit an error and couldn't finish
      // this turn" bubble which `closeWithBubble` used to OVERWRITE the finished
      // reply — a FALSE failure on a succeeded turn (2026-08-04, codeagent-dtz7:
      // confirmed live on Rafael's 18-min turn, `prompt ← ok` then `prompt
      // failed: HTTP 404` on the ack). The turn already succeeded — log the ack
      // miss and stop; do NOT cancel (nothing is stuck) or synthesize a bubble.
      if (turnClosed) {
        log.warn(
          'acpRunner',
          `post-close ack failed (turn already delivered) id=${cmd.id.slice(0, 8)}: ${describeError(err)}`,
        );
        return;
      }
      // Whether the turn ALREADY streamed VISIBLE progress before it threw —
      // assistant text OR thinking/tool activity (`hasVisibleProgress`, NOT
      // `getCurrentText` alone). When it did, `closeAll` finalises that partial
      // reply as the terminal frame — we must NOT clobber it. When it didn't, the
      // only frame is an empty `done:true` (dropped by the mobile snapshot-guard),
      // so we MUST synthesize a visible failure bubble below.
      //
      // ⚠️ Text ALONE is the wrong signal: a long agentic turn streams lots of
      // tool/thinking progress and can throw (idle watchdog tripping as the agent
      // finishes its last tool, or a trailing error after the work completed)
      // BEFORE a final `text` reply. Treating that as "no content" fired the
      // generic TURN_FAILURE_MESSAGE and `closeWithBubble` REPLACED the whole
      // streamed transcript with it — the error wiped a finished turn and
      // mis-reported "couldn't finish" (2026-07-17). The broader check keeps such
      // a turn on the non-destructive `closeAll` (bubble === null) path.
      const hadText = streaming.hasVisibleProgress();
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
        await budgetRecovery.offer(cmd.id, turnBlocks, `${detail}\n${recentStderr.join('\n')}`);
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
      return;
    }
  }
}

/**
 * `squad_configure` — read/write the session's autonomous-handoff mode
 * (`headroom_configure` shape). `set` persists to `~/.codeam/config.json` so
 * the mode survives a CLI restart; both actions ack the state AFTER the
 * command, including the budget the CLI actually applied (a malformed
 * `hopBudget` is CLAMPED, never rejected — the ack is the source of truth for
 * what the UI should render).
 *
 * The PRO gate lives on the BACKEND's command-send path (403 PREMIUM_REQUIRED),
 * exactly like `headroom_configure`; the CLI's own gate is `roster.handoffsEnabled`
 * at proposal time, so enabling the mode on a FREE plan is inert rather than
 * an error.
 */
async function squadConfigureH(ctx: AcpCommandContext): Promise<void> {
  const { cmd, relay, opts, squad } = ctx;
  if (!squad) {
    await relay.sendResult(cmd.id, 'failed', {
      error: 'Agent Squad is not available on this session.',
    });
    return;
  }
  const payload = cmd.payload as SquadConfigurePayload | undefined;
  if (payload?.action === 'set') {
    const applied = squad.setAuto({
      enabled: payload.autoHandoffs === true,
      hopBudget: clampHopBudget(payload.hopBudget),
    });
    // Persistence is best-effort: an unknown pluginId (session removed between
    // the tap and the command) still leaves the in-memory mode correct.
    setSquadAuto(opts.pluginId, applied);
    log.info(
      'acpRunner',
      `squad: auto handoffs ${applied.enabled ? 'ON' : 'OFF'} budget=${applied.hopBudget}`,
    );
    const result: SquadConfigureResult = { ...applied, hopsRemaining: squad.hopsRemaining() };
    await relay.sendResult(cmd.id, 'completed', { ...result });
    return;
  }
  if (payload?.action === 'status') {
    const result: SquadConfigureResult = {
      ...squad.auto,
      hopsRemaining: squad.hopsRemaining(),
    };
    await relay.sendResult(cmd.id, 'completed', { ...result });
    return;
  }
  await relay.sendResult(cmd.id, 'failed', { error: 'squad_configure: unknown action' });
}

/** `squad_stats` — per-member activity for the app's "Squad activity" screen. */
async function squadStatsH(ctx: AcpCommandContext): Promise<void> {
  const { cmd, relay, squad } = ctx;
  if (!squad) {
    await relay.sendResult(cmd.id, 'failed', {
      error: 'Agent Squad is not available on this session.',
    });
    return;
  }
  const stats: SquadStatsResult = squad.stats();
  await relay.sendResult(cmd.id, 'completed', { ...stats });
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
  const promptText = typeof payload?.prompt === 'string' ? payload.prompt : '';
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
  const { cmd, relay, client } = ctx;
  // NATIVE ACP is the SINGLE source of truth: the models come from the agent's
  // own `category:'model'` config option (captured on newSession/loadSession),
  // NOT a hardcoded per-agent strategy list. An agent that exposes no model
  // selector returns an EMPTY list → mobile hides the model picker for it.
  // `currentModelId` lets mobile mark the in-use model (the model line under the
  // composer) without a separate round-trip; `undefined` when no model option.
  await relay.sendResult(cmd.id, 'completed', {
    models: client.getAvailableModels(),
    currentModelId: client.getCurrentModelId(),
  });
  return;
}

async function listModesH(ctx: AcpCommandContext): Promise<void> {
  const { cmd, relay, client } = ctx;
  // NATIVE ACP is the SINGLE source of truth: the modes come from the agent's
  // own `SessionModeState` (captured on newSession/loadSession) — a DIFFERENT
  // axis than models. An agent that advertises no modes returns an EMPTY list →
  // mobile hides the mode picker for it. `currentModeId` lets mobile mark the
  // active mode without a separate round-trip; `undefined` when no modes.
  await relay.sendResult(cmd.id, 'completed', {
    modes: client.getAvailableModes(),
    currentModeId: client.getCurrentModeId(),
  });
  return;
}

async function setModeH(ctx: AcpCommandContext): Promise<void> {
  const { cmd, client, relay, opts } = ctx;
  // client.setMode drives the NATIVE `session/set_mode` RPC against the agent's
  // own `SessionModeState` (single source of truth). Agents that advertise no
  // modes throw → we ack `failed` with the reason so mobile surfaces "mode
  // switching not supported on this agent".
  const payload = cmd.payload as { modeId?: string };
  const modeId = payload?.modeId?.trim();
  if (!modeId) {
    await relay.sendResult(cmd.id, 'failed', { error: 'modeId required' });
    return;
  }
  try {
    await client.setMode(modeId);
    // Keep the CLI's auto-approve IN SYNC with the chosen mode. On a MANAGED
    // session (codespace / self-hosted) `autoApprovePermissions` starts true
    // (CODESPACES / CODEAM_AUTO_APPROVE at spawn) so headless turns never stall.
    // But that made the mobile mode toggle a NO-OP: switching to a manual "ask"
    // mode still auto-approved every tool, because onRequestPermission only reads
    // this flag — the agent's native mode changed but the CLI kept auto-approving
    // (Rafael, 2026-08-08 — "en manual no pregunta yes/no, deniega solo"). Only a
    // full-bypass mode keeps auto-approve; every ask-mode flips it false so the
    // agent's permission prompts RELAY to mobile. A headless session never sends
    // set_mode, so it stays auto.
    opts.autoApprovePermissions = modeIsFullAutoApprove(modeId);
    log.info(
      'acpRunner',
      `set_mode → ${modeId} (autoApprovePermissions=${opts.autoApprovePermissions})`,
    );
    await relay.sendResult(cmd.id, 'completed', { modeId });
  } catch (err) {
    log.warn('acpRunner', `set_mode failed: ${describeError(err)}`);
    await relay.sendResult(cmd.id, 'failed', {
      error: `Mode switching not supported on ${opts.agent} via ACP: ${describeError(err)}`,
    });
  }
  return;
}

async function skillsConfigureH(ctx: AcpCommandContext): Promise<void> {
  const { cmd, relay } = ctx;
  // On-demand add/remove/list of a curated Agent Skill for THIS session.
  // Pure filesystem + manifest work (materialize/remove under ~/.claude/skills/
  // + ~/.codeam/skills.json) — no PTY/ACP-adapter dependency, so no try/catch
  // recovery dance is needed; `configureSkill` itself is best-effort internally.
  const payload = cmd.payload as { action?: SkillsConfigureAction; skillId?: string };
  const res = configureSkill(payload?.action ?? 'list', payload?.skillId);
  await relay.sendResult(cmd.id, res.ok ? 'completed' : 'failed', res);
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
  const { cmd, client, relay, streaming, history, budgetRecovery } = ctx;
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
    // ── Make the switched conversation REACHABLE (2026-07-16 fix) ──
    // The load replay is deliberately swallowed (the anti-stuck-Thinking
    // guard), so the conversation CONTENT must reach mobile through the
    // canonical path instead. Three steps, in order:
    // 1. Re-point every future command at the new id — get_conversation
    //    acks, transcript uploads, one-shots. Without this the session
    //    kept serving the OLD conversation after a resume.
    ctx.history.switchActiveSession(id);
    ctx.onActiveSessionChanged?.(id);
    // 2. Upload the switched conversation's JSONL BEFORE acking, so the
    //    mobile's follow-up get_conversation → GET finds it stored (first
    //    upload for this id in this process → full batched baseline).
    try {
      await ctx.jsonlHistory.uploadConversationIfChanged(id);
    } catch (err) {
      log.warn('acpRunner', `resume_session: transcript upload failed: ${describeError(err)}`);
    }
    // 3. Refresh the RECENT list (ordering/titles) — best-effort.
    void (async () => {
      try {
        const listed = await client.listSessions();
        if (listed && listed.length > 0) {
          await ctx.publisher.pushSessionList({ agentId: opts.agent, sessions: listed });
        }
      } catch (err) {
        log.warn('acpRunner', `resume_session: list push failed: ${describeError(err)}`);
      }
    })();
    await relay.sendResult(cmd.id, 'completed', { sessionId: id });
  } catch (err) {
    log.warn('acpRunner', `resume_session failed: ${describeError(err)}`);
    await relay.sendResult(cmd.id, 'failed', { error: describeError(err) });
  }
  return;
}

async function changeModelH(ctx: AcpCommandContext): Promise<void> {
  const { cmd, client, relay, opts } = ctx;
  // client.setModel drives the NATIVE `session/set_config_option` RPC against
  // the agent's own `category:'model'` config option (single source of truth).
  // Agents that expose no model config option throw → we ack `failed` with the
  // reason so mobile surfaces "model picker not supported on this agent".
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
        return (commandId: string, status: string, result: Record<string, unknown>) => {
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
          return (commandId: string, status: string, result: Record<string, unknown>) => {
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

/** Warm the npm/uvx package cache for a NEW integration MCP server so its first
 *  tool call doesn't race the cold download past the agent's MCP-init window
 *  (the Sentry incident). Best-effort, bounded, parallel; HTTP-transport
 *  integrations (empty command) are skipped. */
async function prewarmNewMcpEntries(
  manifest: IntegrationsManifest,
  previousIds: Set<string>,
): Promise<void> {
  const PREWARMABLE = new Set(['npx', 'uvx']);
  const fresh = manifest.integrations.filter(
    (e) => !previousIds.has(e.id) && e.delivery.mcp && PREWARMABLE.has(e.delivery.mcp.command),
  );
  await Promise.all(
    fresh.map(
      (e) =>
        new Promise<void>((resolve) => {
          const mcp = e.delivery.mcp!;
          const child = execFile(mcp.command, [...mcp.args, '--help'], { timeout: 90_000 }, () =>
            resolve(),
          );
          child.on('error', () => resolve());
        }),
    ),
  );
}

/**
 * Session Tools — `integrations_sync`: the backend already persisted the new
 * attached set and pushed the freshly-resolved manifest here. Rewrite the box
 * manifest, warm any NEW MCP package, then re-register the agent's MCP servers on
 * the live session (respawn-resume; degrades to "next restart" on failure). The
 * ack is relay hygiene only — the backend fired this fire-and-forget and drives
 * the UI off the persisted set + `session_integrations_changed`, so a slow
 * prewarm/respawn never blocks the mobile.
 */
async function integrationsSyncH(ctx: AcpCommandContext): Promise<void> {
  const { cmd, relay, opts, client } = ctx;
  const manifest = (cmd.payload as { manifest?: IntegrationsManifest }).manifest;
  if (!manifest || !Array.isArray(manifest.integrations)) {
    await relay.sendResult(cmd.id, 'failed', { error: 'integrations_sync: missing manifest' });
    return;
  }
  try {
    const previousIds = new Set((readIntegrationsManifest()?.integrations ?? []).map((e) => e.id));
    persistIntegrationsManifest(manifest);
    await prewarmNewMcpEntries(manifest, previousIds);
    const servers = buildMcpServersForStart({
      sessionId: opts.sessionId,
      pluginId: opts.pluginId,
      pluginAuthToken: opts.pluginAuthToken,
      pollSecret: opts.pollSecret,
    });
    const applied = await client.reprovisionMcp(servers);
    await relay.sendResult(cmd.id, 'completed', {
      synced: true,
      applied, // 'reloaded' (live now) | 'deferred' (next restart)
      attached: manifest.integrations.map((e) => e.id),
    });
  } catch (err) {
    // The manifest is already persisted, so the tools still bind on the next
    // re-establishment — report but never fail the session.
    log.warn(
      'acpRunner',
      `integrations_sync failed (tools apply next restart): ${describeError(err)}`,
    );
    await relay.sendResult(cmd.id, 'completed', { synced: false, error: describeError(err) });
  }
}

/**
 * Session Tools — `integrations_detect`: classify the repo stack + recommend
 * integrations (deterministic dependency scan, agent one-shot fallback when the
 * scan is empty). Pure request/response — the mobile sheet awaits the result.
 */
async function integrationsDetectH(ctx: AcpCommandContext): Promise<void> {
  const { cmd, relay, opts } = ctx;
  try {
    const runtime = createInteractiveAgentStrategy(opts.agent, createOsStrategy());
    const detection = await detectRepoStack(opts.cwd, runtime);
    await relay.sendResult(cmd.id, 'completed', detection as unknown as Record<string, unknown>);
  } catch (err) {
    log.warn('acpRunner', `integrations_detect failed: ${describeError(err)}`);
    await relay.sendResult(cmd.id, 'completed', {
      stack: 'unknown',
      detected: [],
      recommended: [],
      source: 'scan',
    });
  }
}

/**
 * Session agent switch — `switch_agent { agentId }`. All the real work
 * (credential pull, binary install, adapter restart, revert-on-failure,
 * progress events) lives in the runner-provided `ctx.switchAgent`
 * orchestration; this handler only validates presence and acks. Sessions
 * without the capability (baton/local TUI, PTY agents) get an honest,
 * immediate failure instead of a hung spinner.
 */
async function switchAgentH(ctx: AcpCommandContext): Promise<void> {
  const { cmd, relay } = ctx;
  if (!ctx.switchAgent) {
    await relay.sendResult(cmd.id, 'failed', {
      error: 'Switching agents is not supported on this session.',
    });
    return;
  }
  const rawAgentId = (cmd.payload as { agentId?: unknown } | undefined)?.agentId;
  try {
    const result = await ctx.switchAgent(rawAgentId);
    await relay.sendResult(
      cmd.id,
      result.ok ? 'completed' : 'failed',
      result as unknown as Record<string, unknown>,
    );
  } catch (err) {
    log.warn('acpRunner', `switch_agent failed: ${describeError(err)}`);
    await relay.sendResult(cmd.id, 'failed', { error: describeError(err) });
  }
}

/**
 * Dispatch table — one entry per explicitly-handled relay command type.
 * Aliased types (stop_task/escape_key, set_keep_alive/get_context,
 * session_terminated/shutdown_session, the preview family) share one handler,
 * exactly as their switch cases shared a body/fall-through before.
 */
export const ACP_COMMAND_HANDLERS: Record<string, AcpCommandHandler> = {
  integrations_sync: integrationsSyncH,
  integrations_detect: integrationsDetectH,
  beads_action: beadsActionH,
  start_task: startTaskH,
  group_mention_task: groupMentionTaskH,
  stop_task: stopTaskH,
  escape_key: stopTaskH,
  get_conversation: getConversationH,
  list_models: listModelsH,
  list_modes: listModesH,
  set_mode: setModeH,
  set_keep_alive: ackEmptyH,
  get_context: ackEmptyH,
  select_option: selectOptionH,
  provide_input: provideInputH,
  resume_session: resumeSessionH,
  switch_agent: switchAgentH,
  change_model: changeModelH,
  summarize: summarizeH,
  session_terminated: sessionShutdownH,
  shutdown_session: sessionShutdownH,
  request_preview_detect: previewH,
  preview_start: previewH,
  preview_stop: previewH,
  save_preview_config: previewH,
  skills_configure: skillsConfigureH,
  pack_start: packStartH,
  pack_action: packActionH,
  pack_status: packStatusH,
  [SQUAD_CONFIGURE_COMMAND]: squadConfigureH,
  [SQUAD_STATS_COMMAND]: squadStatsH,
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
