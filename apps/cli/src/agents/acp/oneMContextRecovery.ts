/**
 * On-demand recovery for Anthropic's "Usage credits required for 1M context"
 * gate (Rafael, 2026-06-24). claude Code v2.1.x sends the `context-1m` beta
 * even when the account lacks 1M credits, so every turn 429s. Rather than
 * disabling 1M for ALL users, we detect THIS error and offer the affected
 * user a single tappable action — "Disable 1M context and continue" — which
 * re-spawns the agent with `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` and re-runs the
 * failed prompt. This module owns the (pure) detection + offer; the runner
 * owns the side-effecting re-spawn + persistence.
 */

import { looksLike1mContextCreditsError } from './runner';

/** The single option label. The runner maps `select_option {index:0}` to it. */
export const ONE_M_DISABLE_OPTION = 'Disable 1M context and continue';

export interface PromptBlockLike {
  type: string;
  text?: string;
}

export interface OneMRecoveryState {
  /** The prompt blocks that hit the 1M-credits gate, stashed so the runner
   *  can re-dispatch them verbatim after the re-spawn. Null when no recovery
   *  is pending. */
  pending: { blocks: ReadonlyArray<PromptBlockLike> } | null;
}

export function makeOneMRecoveryState(): OneMRecoveryState {
  return { pending: null };
}

/**
 * True when a failed turn's signals indicate the 1M-context usage-credits
 * gate — checked across the thrown error detail, recent stderr, and the
 * agent's completed-reply text (Anthropic can surface the 429 body as the
 * reply on a "successful" turn, like the auth-notice case).
 */
export function shouldOfferOneMRecovery(opts: {
  detail: string;
  recentStderr: string;
  finalText: string;
}): boolean {
  return (
    looksLike1mContextCreditsError(opts.detail) ||
    looksLike1mContextCreditsError(opts.recentStderr) ||
    looksLike1mContextCreditsError(opts.finalText)
  );
}

/** The select-prompt payload the runner publishes so mobile renders the
 *  tappable recovery action. */
export function oneMRecoverySelectPrompt(): { question: string; options: string[] } {
  return {
    question:
      "⚠️ This agent's Anthropic account needs usage credits for 1M context. " +
      'You can disable 1M context (uses standard 200K context) and continue.',
    options: [ONE_M_DISABLE_OPTION],
  };
}

/**
 * Dependencies the recovery needs from the runner. All side-effecting calls
 * are injected so the offer/tryRecover behavior is unit-testable with fakes
 * (the runner wires them to the live publisher/relay/streaming/AcpClient).
 * Generic over the prompt-block type `B` so the stashed blocks round-trip to
 * `client.prompt` without a cast.
 */
export interface OneMRecoveryDeps<B> {
  publishText: (text: string) => Promise<void>;
  publishSelectPrompt: (question: string, options: string[]) => Promise<void>;
  sendResult: (commandId: string, status: 'completed' | 'failed', result: Record<string, unknown>) => Promise<void>;
  appendAgentReply: (text: string) => void;
  flushHistory: () => void;
  beginTurn: () => Promise<void>;
  getCurrentText: () => string;
  closeTurn: () => Promise<void>;
  recoverFromFailedTurn: () => Promise<void>;
  /** Disable 1M (persist) + re-spawn the agent so the next prompt drops the
   *  `context-1m` beta. */
  reconnectWith1mDisabled: () => Promise<void>;
  /** Run a prompt on the (post-reconnect) live agent. */
  promptAgent: (blocks: readonly B[]) => Promise<{ stopReason?: string }>;
  /** failureBubble(detail) for the re-run's own failure path. */
  failureBubbleFor: (detail: string) => string | null;
  describeError: (err: unknown) => string;
  log?: (msg: string) => void;
}

export interface OneMRecovery<B> {
  /** Publish the tappable action + stash the failed prompt; ends the turn as
   *  `failed` (recovery offered). */
  offer: (commandId: string, blocks: readonly B[]) => Promise<void>;
  /** If a recovery is pending, disable 1M + re-spawn + re-run the stashed
   *  prompt and return true; otherwise return false (caller falls through). */
  tryRecover: (commandId: string) => Promise<boolean>;
}

export function createOneMRecovery<B>(deps: OneMRecoveryDeps<B>): OneMRecovery<B> {
  let pending: { blocks: readonly B[] } | null = null;
  const sp = oneMRecoverySelectPrompt();

  return {
    offer: async (commandId, blocks) => {
      pending = { blocks };
      // The select_prompt chunk alone makes mobile render the button + send
      // back select_option — no awaiting-answer sheet needed.
      await deps.publishText(sp.question);
      await deps.publishSelectPrompt(sp.question, sp.options);
      deps.appendAgentReply(sp.question);
      deps.flushHistory();
      deps.log?.(`1M-context credits gate — recovery offered id=${commandId.slice(0, 8)}`);
      await deps.sendResult(commandId, 'failed', {
        error: '1M context requires usage credits — recovery offered',
      });
    },
    tryRecover: async (commandId) => {
      if (!pending) return false;
      const blocks = pending.blocks;
      pending = null;
      deps.log?.('1M-context recovery → disable + reconnect + rerun');
      await deps.reconnectWith1mDisabled();
      await deps.beginTurn();
      try {
        const reply = await deps.promptAgent(blocks);
        const finalText = deps.getCurrentText();
        await deps.closeTurn();
        deps.appendAgentReply(finalText);
        deps.flushHistory();
        await deps.sendResult(commandId, 'completed', { stopReason: reply.stopReason });
      } catch (err) {
        await deps.recoverFromFailedTurn();
        const d = deps.describeError(err);
        const b = deps.failureBubbleFor(d);
        if (b) {
          await deps.publishText(b);
          deps.appendAgentReply(b);
          deps.flushHistory();
        }
        await deps.sendResult(commandId, 'failed', { error: d });
      }
      return true;
    },
  };
}
