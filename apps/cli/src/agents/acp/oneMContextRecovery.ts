/**
 * Detection helpers for Anthropic's "Usage credits required for 1M context"
 * gate (Rafael, 2026-06-24). claude Code v2.1.x sends the `context-1m` beta
 * even when the account lacks 1M credits, so every turn 429s.
 *
 * The recovery is now to RECONNECT the Claude subscription via the in-app OAuth
 * (`failure-messages.ts` → `ONE_M_CREDITS_MESSAGE` + `reportCredentialInvalid`);
 * disabling 1M never fixed a credential-type credits gate. The old
 * disable/re-spawn DI factory (`createOneMRecovery`) that used to live here was
 * removed — only these two pure detectors remain, consumed by
 * `failure-messages.ts` and `command-handlers.ts`.
 */

/**
 * Detects Anthropic's "Usage credits required for 1M context" gate. claude
 * Code v2.1.x sends the `context-1m` beta even when the account has
 * `s1mAccessCache.hasAccess=false`; an account without usage credits then
 * gets a 429 with this body. Lives here (not in runner.ts) so this module has
 * NO import back into the heavy runner graph — runner re-exports it.
 */
const ONE_M_CONTEXT_CREDITS_RE = /usage credits required for 1m context/i;

export function looksLike1mContextCreditsError(text: string): boolean {
  return ONE_M_CONTEXT_CREDITS_RE.test(text);
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
