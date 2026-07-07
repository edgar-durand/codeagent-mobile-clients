/**
 * Failure classification + user-facing failure copy for ACP sessions.
 *
 * Extracted VERBATIM from `runner.ts` (Phase 3 refactor, bd codeagent-2sa) so
 * the per-command handlers (`command-handlers.ts`) and the runner can share
 * these leaf helpers without a runtime import cycle. Everything here is pure
 * (string in → classification/message out) and unit-tested through
 * `__tests__/agents/acp.failureBubble.test.ts` & friends via the re-exports
 * kept on `runner.ts`.
 *
 * The ACP failure-messaging CONTRACT lives here: a turn NEVER ends silently
 * or with a misleading status — see {@link failureBubble} and the repo
 * CLAUDE.md "Agent-failure messaging" section.
 */

import { looksLike1mContextCreditsError } from './oneMContextRecovery';
import { looksLikeBudgetExceeded, extractBudgetPeriod } from './budgetRecovery';

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
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
 * True when an agent's COMPLETED-turn reply IS itself an auth-failure notice.
 * Claude Code, when its credential is missing/expired, prints
 * "Not logged in · Please run /login" as a plain assistant message and ends
 * the turn cleanly — no thrown error, no process exit — so the throw/exit auth
 * paths never see it and the raw CLI text leaks into the chat (and the
 * credential is never flagged EXPIRED). Length-guarded so a substantive reply
 * that merely DISCUSSES login (e.g. the user asked how to fix it) is not
 * misclassified — a genuine auth notice is short.
 */
export function replyIsAuthFailure(finalText: string): boolean {
  const t = finalText.trim();
  return t.length > 0 && t.length <= 200 && looksLikeAuthFailure(t);
}

/**
 * Persistent, actionable message shown in the chat when a turn fails because
 * the agent's credential is invalid/expired. Markdown — the chat renderer
 * supports it (same as the welcome banner).
 */
export const AUTH_FAILURE_MESSAGE =
  '🔒 **Authentication failed — your agent credentials are invalid or expired (API 401).**\n\n' +
  // `codeam://reauth` is an in-app deep-link the mobile chat intercepts
  // (MarkdownAppLinkProvider → Profile › Agents, preselecting this agent).
  // On any surface that can't handle the scheme it just renders as a tappable
  // label, so the instruction still reads correctly.
  'Tap [Re-authenticate this agent](codeam://reauth) to renew your credentials in Profile › Agents, then send your message again.';

/**
 * True when a cursor-agent reply IS Cursor's own plan paywall — "Upgrade your
 * plan to continue". The user's CURSOR account has no active plan/credits to
 * run the agent. This is NOT a credential problem (the login works), so we do
 * NOT flag the credential invalid or offer re-link; we point the user at their
 * Cursor account to upgrade. Length-guarded so a reply that merely DISCUSSES
 * plans isn't misclassified.
 */
export function replyIsCursorUpgradeRequired(finalText: string): boolean {
  const t = finalText.trim().toLowerCase();
  if (t.length === 0 || t.length > 200) return false;
  return (
    t.includes('upgrade your plan to continue') ||
    (t.includes('upgrade your plan') && t.includes('continue'))
  );
}

/**
 * Actionable bubble when the user's Cursor ACCOUNT needs a paid plan to run the
 * agent. Links to the user's own Cursor account billing page (a real https URL
 * the chat renders as tappable) — NOT a re-link/re-auth flow, the credential is
 * fine. This is Cursor's paywall, not CodeAgent's.
 */
export const CURSOR_UPGRADE_MESSAGE =
  '⚡ **Cursor needs a paid plan to run the agent.**\n\n' +
  'The headless Cursor Agent requires Cursor **Pro** — your Free plan’s included usage does NOT cover Agent runs, even with quota left. This is your Cursor account (not CodeAgent). Upgrade, then send your message again:\n\n' +
  '[Upgrade to Cursor Pro →](https://cursor.com/dashboard)';

/**
 * Persistent, actionable message when the agent's reply IS Anthropic's "Usage
 * credits required for 1M context" 429. Shipped v2.43.0 offered "Disable 1M
 * context and continue", but that does NOT fix a credential-type credits gate
 * (2026-06-24 incident) — the account's credential simply lacks the entitlement.
 * The real recovery is reconnecting the Claude subscription via the in-app
 * OAuth (Profile › Agents), so we surface the same `codeam://reauth` re-link CTA
 * as the auth-failure path.
 */
export const ONE_M_CREDITS_MESSAGE =
  '🔄 **Reconnect your Claude subscription to continue.**\n\n' +
  'Claude requested 1M-context but your account doesn’t have the usage credits for it on this credential. Reconnecting refreshes your subscription so the agent can keep going — disabling 1M context won’t fix a credits gate.\n\n' +
  'Tap [Reconnect this agent](codeam://reauth) to reconnect your Claude subscription in Profile › Agents, then send your message again.';

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

/**
 * Detects a turn failure caused by the AGENT PROVIDER being down / overloaded
 * (Anthropic, OpenAI, …) rather than the user's session or credential — e.g.
 * Anthropic's HTTP 529 `overloaded_error`, or an upstream 5xx / "service
 * unavailable". This is a leading cause of an agent that appears to "hang":
 * the provider is having an incident, so the call never completes. We surface
 * a friendly, transparent message (with the provider's status page) instead of
 * a silent stall or a misleading generic "try again".
 */
const PROVIDER_OUTAGE_RE =
  /overloaded_error|\boverloaded\b|service[ _]unavailable|temporarily[ _]unavailable|(?:api error|http|status)[:\s]+(?:529|503|502|504)\b|\b(?:529|503|502|504)\b[^\n]{0,40}(?:overload|unavailable|gateway|upstream|server error)|bad gateway|gateway time-?out|upstream (?:error|connect|timeout)/i;

export function looksLikeProviderOutage(text: string): boolean {
  return PROVIDER_OUTAGE_RE.test(text);
}

/**
 * Public status page for an agent's upstream provider, resolved by substring
 * so it's robust to the runtime id (`claude`) vs the public id (`claude_code`).
 * Returns null for agents whose provider we don't have a status URL for — the
 * outage message then degrades gracefully to a vendor-less form.
 */
export function agentStatusPage(
  agent: string,
): { vendor: string; url: string } | null {
  const a = (agent ?? '').toLowerCase();
  if (a.includes('claude') || a.includes('anthropic'))
    return { vendor: 'Anthropic', url: 'https://status.anthropic.com' };
  if (a.includes('codex') || a.includes('openai'))
    return { vendor: 'OpenAI', url: 'https://status.openai.com' };
  if (a.includes('gemini') || a.includes('google'))
    return { vendor: 'Google', url: 'https://status.cloud.google.com' };
  if (a.includes('copilot'))
    return { vendor: 'GitHub', url: 'https://www.githubstatus.com' };
  if (a.includes('cursor'))
    return { vendor: 'Cursor', url: 'https://status.cursor.com' };
  return null;
}

/**
 * Friendly, transparent bubble for a provider-side outage/overload. Names the
 * vendor, reassures the user it isn't their session, and links the provider's
 * status page so they can follow the incident. Markdown (the chat renderer
 * supports links).
 */
export function providerOutageMessage(agent: string): string {
  const info = agentStatusPage(agent);
  const who = info ? info.vendor : 'The agent provider';
  return (
    `🌐 **${who} is having a service disruption — this isn’t your session.**\n\n` +
    'The agent provider returned an overload/outage error, so this turn couldn’t finish. ' +
    'It usually clears up on its own — just send your message again in a bit.' +
    (info ? `\n\nFollow the status here: [${info.url}](${info.url})` : '')
  );
}

/** True when a startup failure is Gemini's post-2026-06-18 free-tier death. */
function isGeminiIneligibleTier(haystack: string): boolean {
  return /IneligibleTierError|UNSUPPORTED_CLIENT|no longer supported for Gemini Code Assist|not eligible for Gemini Code Assist/i.test(
    haystack,
  );
}

/**
 * Human-facing chat message for an agent that FAILED TO START (its ACP
 * `newSession` never produced a session — e.g. Gemini's Code Assist onboarding
 * rejecting the account). Surfaced so the session shows WHY instead of sitting
 * on "STILL LOADING SESSION HISTORY / offline" forever.
 */
export function startupFailureMessage(agent: string, detail: string, recentStderr: string): string {
  const haystack = `${detail}\n${recentStderr}`;
  if (agent === 'gemini' && isGeminiIneligibleTier(haystack)) {
    return [
      "⚠️ **Gemini couldn't start — your Google account isn't eligible.**",
      '',
      "Google discontinued free **“Login with Google”** access to the Gemini CLI on 2026-06-18. The free / individual tier (and Google AI Pro/Ultra) can no longer authenticate here.",
      '',
      'To use Gemini from CodeAgent, re-link it in **Profile › Agents** with either:',
      '• a **Gemini API key** (AI Studio — free quota available), or',
      '• a paid **Gemini Code Assist (Standard/Enterprise)** subscription.',
    ].join('\n');
  }
  if (looksLikeAuthFailure(haystack)) return AUTH_FAILURE_MESSAGE;
  if (looksLikeProviderOutage(haystack)) return providerOutageMessage(agent);
  const tail = recentStderr.split('\n').filter(Boolean).slice(-3).join('\n');
  return [
    `⚠️ The ${agent} agent failed to start.`,
    '',
    tail ? `Details:\n${tail}` : detail,
  ].join('\n');
}

/**
 * Build the budget-exceeded bubble. The `period` is extracted from the 429
 * detail string (e.g. "daily"). Exported so tests can compare it verbatim.
 */
export function budgetBubbleMessage(agent: string, period: string): string {
  return (
    `💸 **Headroom budget reached for the ${period} period.**\n\n` +
    `The local Headroom proxy rejected the ${agent} request because the configured spending cap was hit. ` +
    'Choose an option below to continue.'
  );
}

/**
 * Decide the terminal failure bubble to publish when a `start_task` turn
 * throws — the contract that guarantees a turn NEVER ends silently:
 *   - auth failure → the actionable re-auth bubble.
 *   - provider outage (529 / 5xx / overloaded) → a transparent "provider is
 *     down" bubble with the status-page link, shown even if partial text
 *     streamed (the user must know it's the provider, not a stuck session).
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
  agent: string;
}): string | null {
  if (looksLikeAuthFailure(opts.detail) || looksLikeAuthFailure(opts.recentStderr)) {
    return AUTH_FAILURE_MESSAGE;
  }
  // Anthropic "Usage credits required for 1M context" 429 — a credential-type
  // credits gate. Disabling 1M doesn't fix it; the recovery is reconnecting the
  // Claude subscription (in-app OAuth), so surface the reconnect bubble.
  if (
    looksLike1mContextCreditsError(opts.detail) ||
    looksLike1mContextCreditsError(opts.recentStderr)
  ) {
    return ONE_M_CREDITS_MESSAGE;
  }
  // Budget-exceeded 429 from the local Headroom proxy — checked BEFORE the
  // provider-outage branch so a budget 429 is never mis-classified as a
  // provider outage. The proxy is local; the agent provider is healthy.
  const budgetHaystack = `${opts.detail}\n${opts.recentStderr}`;
  if (looksLikeBudgetExceeded(budgetHaystack)) {
    return budgetBubbleMessage(opts.agent, extractBudgetPeriod(budgetHaystack));
  }
  if (looksLikeProviderOutage(opts.detail) || looksLikeProviderOutage(opts.recentStderr)) {
    return providerOutageMessage(opts.agent);
  }
  if (!opts.hadText) return TURN_FAILURE_MESSAGE;
  return null;
}

/**
 * Windows `STATUS_CONTROL_C_EXIT` (0xC000013A). The agent adapter process
 * was terminated by a Ctrl+C / console-close event — the user ending the
 * session, NOT a crash. It exits with this NTSTATUS on Windows when the
 * terminal window is closed or Ctrl+C is pressed.
 */
export const WINDOWS_CONTROL_C_EXIT = 3221225786; // 0xC000013A

/**
 * Message to publish when the ACP adapter dies OUTSIDE an intentional
 * `client.stop()`, or `null` to suppress the bubble entirely because the
 * exit was a benign user-initiated shutdown (not a crash).
 *
 * Why the benign cases matter: a Windows user who just closes their
 * terminal exits the adapter with 0xC000013A. Classifying that as
 * "Agent adapter exited unexpectedly (code=3221225786 …)" surfaced a
 * cryptic fake crash to the user AND recorded it as a failed session in
 * the daily email digest (2026-07-04, a win32 CLI user). SIGINT is the
 * POSIX equivalent (Ctrl+C). Both are the user ending the session.
 *
 * Pure + exported so the classification is unit-tested without spawning a
 * real adapter.
 */
export function adapterExitMessage(opts: {
  code: number | null;
  signal: string | null;
  authFail: boolean;
  outageFail: boolean;
  agent: string;
}): string | null {
  // Benign, user-initiated shutdowns — never a crash bubble, never a
  // digest error.
  if (opts.code === WINDOWS_CONTROL_C_EXIT) return null;
  if (opts.signal === 'SIGINT') return null;
  // Real failures keep their actionable classification.
  if (opts.authFail) return AUTH_FAILURE_MESSAGE;
  if (opts.outageFail) return providerOutageMessage(opts.agent);
  return `Agent adapter exited unexpectedly (code=${opts.code ?? 'null'} signal=${opts.signal ?? 'null'}).`;
}
