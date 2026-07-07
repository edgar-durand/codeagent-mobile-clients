/**
 * On-demand recovery for Headroom's budget-exceeded 429.
 *
 * When the local Headroom proxy is started with `--budget <USD> --budget-period
 * <period>` and the configured budget is exhausted, it rejects every agent
 * request with HTTP 429 and the body:
 *   {"detail":"Budget exceeded for daily period"}
 *
 * Rather than surfacing a generic "try again" bubble or a silent stall, we
 * detect THIS error and offer the user a two-option tappable recovery:
 *   0. "Pause budget this session" — relaunch the proxy WITHOUT `--budget` so
 *      the agent runs unbounded for the rest of this CLI session.
 *   1. "Raise budget" — emit a deep-link chunk that tells mobile to open the
 *      agent budget settings screen (handled by mobile in a later task).
 *
 * Design mirrors `oneMContextRecovery.ts` exactly: detection + offer are pure
 * (this module has no import back into the heavy runner graph); the runner
 * wires the DI factory (`createBudgetRecovery`) to the live
 * publisher/relay/streaming/restart paths.
 *
 * VERIFIED LIVE (2026-06-28):
 *   HTTP 429 body: {"detail":"Budget exceeded for daily period"}
 *   Period comes from `--budget-period` (hourly | daily | monthly).
 */

/**
 * Detects Headroom's budget-exceeded 429 body.
 *
 * Pattern: "Budget exceeded for <period> period" (case-insensitive).
 * The period is captured for the user-facing bubble (e.g. "daily").
 */
const BUDGET_EXCEEDED_RE = /budget exceeded for (\w+) period/i;

/**
 * True when `text` is (or contains) Headroom's budget-exceeded 429 detail.
 *
 * Called from `failureBubble` (BEFORE the provider-outage branch) so a
 * budget-exceeded 429 never masquerades as an outage or a generic retry.
 */
export function looksLikeBudgetExceeded(text: string): boolean {
  return BUDGET_EXCEEDED_RE.test(text);
}

/**
 * Extract the budget period from the 429 detail string.
 * Returns the captured period word (e.g. "daily") or "current" as a fallback.
 */
export function extractBudgetPeriod(text: string): string {
  const m = BUDGET_EXCEEDED_RE.exec(text);
  return m ? (m[1] ?? 'current') : 'current';
}

/** Option index 0: pause budget for this session (relaunch proxy w/o --budget). */
export const BUDGET_PAUSE_OPTION = 'Pause budget this session';
/** Option index 1: raise the budget cap (deep-links to app settings). */
export const BUDGET_RAISE_OPTION = 'Raise budget';

export interface BudgetRecoveryDeps<B> {
  publishText: (text: string) => Promise<void>;
  publishSelectPrompt: (question: string, options: string[]) => Promise<void>;
  /** Button driver — mobile renders the tappable options from this event. */
  publishAwaitingAnswer: (prompt: string, options: string[]) => Promise<void>;
  /** Emit a raw output chunk (used for the deep-link chunk on "Raise budget"). */
  publishRawChunk: (chunk: Record<string, unknown>) => Promise<void>;
  sendResult: (commandId: string, status: 'completed' | 'failed', result: Record<string, unknown>) => Promise<void>;
  appendAgentReply: (text: string) => void;
  flushHistory: () => void;
  /**
   * Relaunch the Headroom proxy WITHOUT `--budget` args so it runs unbounded
   * for the rest of this session. Best-effort — if the relaunch fails the
   * agent still recovers (it just stays budget-capped). Should resolve when
   * the proxy is accepting connections again.
   */
  relaunchProxyWithoutBudget: () => Promise<void>;
  /** The agent id — forwarded in the deep-link chunk for "Raise budget". */
  agentId: string;
  log?: (msg: string) => void;
}

export interface BudgetRecovery<B> {
  /**
   * Publish the two-option tappable recovery + stash the failed prompt so
   * `tryRecover` can re-run it after the user picks an action.
   * Ends the command as `failed` (recovery offered, not completed).
   */
  offer: (commandId: string, blocks: readonly B[], detail: string) => Promise<void>;
  /**
   * If a recovery is pending and the select_option index matches, execute the
   * chosen action and return true; otherwise return false (caller falls through
   * to the next recovery handler or the normal select_option path).
   *
   * @param commandId  The id of the incoming `select_option` command.
   * @param optionIndex The 0-based option the user selected.
   */
  tryRecover: (commandId: string, optionIndex: number) => Promise<boolean>;
}

/**
 * DI factory — create a `BudgetRecovery` instance wired to the provided
 * deps. The runner wires it to the live publisher / relay / streaming.
 */
export function createBudgetRecovery<B>(deps: BudgetRecoveryDeps<B>): BudgetRecovery<B> {
  // Pending state: stash the failed blocks + captured period for the question.
  let pending: { blocks: readonly B[]; period: string } | null = null;

  const buildQuestion = (period: string): string =>
    `💸 **Headroom budget reached for the ${period} period.**\n\n` +
    'You have two options:\n' +
    '• **Pause budget this session** — removes the spending cap for this session only (the proxy restarts without a budget limit).\n' +
    '• **Raise budget** — open your agent budget settings to increase the cap.';

  return {
    offer: async (commandId, blocks, detail) => {
      const period = extractBudgetPeriod(detail);
      pending = { blocks, period };
      const question = buildQuestion(period);
      const options = [BUDGET_PAUSE_OPTION, BUDGET_RAISE_OPTION];

      // 1. Visible text bubble (legacy chat surface / plain fallback).
      await deps.publishText(question);
      // 2. select_prompt chunk (legacy chat surface).
      await deps.publishSelectPrompt(question, options);
      // 3. Awaiting-answer event — THE button driver on SessionDetail.
      await deps.publishAwaitingAnswer(question, options);

      deps.appendAgentReply(question);
      deps.flushHistory();
      deps.log?.(`budget-exceeded recovery offered period=${period} id=${commandId.slice(0, 8)}`);
      await deps.sendResult(commandId, 'failed', {
        error: `Headroom budget exceeded (${period}) — recovery offered`,
      });
    },

    tryRecover: async (commandId, optionIndex) => {
      if (!pending) return false;
      const { blocks, period } = pending;
      pending = null;

      if (optionIndex === 0) {
        // "Pause budget this session" — relaunch proxy w/o --budget.
        deps.log?.('budget recovery → pause: relaunching proxy without budget');
        try {
          await deps.relaunchProxyWithoutBudget();
        } catch (err) {
          deps.log?.(`budget recovery → relaunch failed (best-effort): ${String(err)}`);
        }
        // Acknowledge the select_option — the user's next prompt will
        // route through the now-unbounded proxy normally. We do NOT
        // re-run the failed prompt automatically (unlike 1M recovery)
        // because the blocks are no longer stashed and the user may want
        // to edit before resending.
        await deps.sendResult(commandId, 'completed', {
          action: 'pause',
          period,
          note: 'Headroom proxy relaunched without budget limit for this session. Send your message again.',
        });
        // Surface a short confirmation bubble so the user knows what happened.
        const note =
          '✅ **Budget paused for this session.** The proxy is running without a spending cap — send your message again.';
        await deps.publishText(note);
        deps.appendAgentReply(note);
        deps.flushHistory();
        deps.log?.(`budget recovery → pause complete id=${commandId.slice(0, 8)}`);
      } else {
        // "Raise budget" — emit a deep-link chunk so mobile opens the
        // agent budget settings. The chunk shape is stable; mobile reads
        // it in a later task (T16). We always ack completed so mobile
        // doesn't retry.
        deps.log?.(`budget recovery → raise: emitting deep-link for agent=${deps.agentId}`);
        await deps.publishRawChunk({
          type: 'open_agent_budget_settings',
          agentId: deps.agentId,
          done: true,
        });
        await deps.sendResult(commandId, 'completed', {
          action: 'raise',
          agentId: deps.agentId,
        });
        deps.log?.(`budget recovery → raise emitted id=${commandId.slice(0, 8)}`);
      }

      return true;
    },
  };
}
