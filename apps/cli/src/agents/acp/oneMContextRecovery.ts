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
