/**
 * Per-agent ACP behaviour hooks — a pure, dependency-free registry keyed by
 * {@link AgentId} that RELOCATES the handful of `if (agent === 'X')` special
 * cases that used to be hardcoded inside `runner.ts` / `command-handlers.ts` /
 * `failure-messages.ts` (audit C1). Adding a new agent's quirk now means adding
 * an entry here instead of editing those hot files.
 *
 * Why a SEPARATE registry (not the ACP adapter `REGISTRY` in `adapters.ts` nor
 * the shared `AGENT_REGISTRY`):
 *   - `adapters.ts`'s `REGISTRY` factories are BINARY-GATED (they `resolveBin`
 *     the adapter package and return `null` when it isn't installed), so a unit
 *     test — or any environment without the adapter on disk — could not read an
 *     agent's `statusPage`. These hooks must be available unconditionally.
 *   - `@codeam/shared`'s `AGENT_REGISTRY` is the cross-repo protocol contract of
 *     pure DATA; the CLI-behavioural predicates below (classify a reply, build
 *     spawn env) don't belong there.
 *
 * This module is a strict LEAF — it imports ONLY the `AgentId` type. In
 * particular it does NOT import `failure-messages.ts` (which imports THIS
 * module), so there is no runtime import cycle. The one agent-specific message
 * that stays in `failure-messages.ts` (the Cursor upgrade bubble) is applied at
 * the call site, keyed off the discriminant a hook returns here.
 */

import type { AgentId } from '@codeam/shared';

export interface AcpAgentHooks {
  /**
   * Extra environment for THIS agent's ACP adapter spawn, given the session
   * context. Relocates runner's `agent === 'codex' && autoApprovePermissions`
   * branch (Codex needs `INITIAL_AGENT_MODE=agent-full-access` in the
   * autonomous plane so its sandbox stops blocking the loopback Beads socket).
   */
  startupExtraEnv?: (ctx: { autoApprovePermissions?: boolean }) => Record<string, string>;
  /**
   * Upstream provider status page — the `{ vendor, url }` the provider-outage
   * bubble names + links. Relocates the per-vendor DATA of the
   * `agentStatusPage` table (the alias substring matching stays in
   * `failure-messages.ts`, which reads this).
   */
  statusPage?: { vendor: string; url: string };
  /**
   * Classify an agent's COMPLETED-turn reply into an agent-specific terminal
   * outcome. Relocates command-handlers' `agent === 'cursor' &&
   * replyIsCursorUpgradeRequired(...)` branch. `'upgrade_required'` ⇒ Cursor's
   * own plan paywall arrived as the reply.
   */
  classifyCompletedReply?: (finalText: string) => 'upgrade_required' | null;
  /**
   * Classify a STARTUP-failure haystack (`detail` + recent stderr) into an
   * agent-specific reason. Relocates failure-messages' `agent === 'gemini' &&
   * isGeminiIneligibleTier(...)` branch. `'ineligible_tier'` ⇒ Gemini's
   * post-2026-06-18 free-tier Code Assist deprecation.
   */
  classifyStartupFailure?: (haystack: string) => 'ineligible_tier' | null;
}

/**
 * True when a cursor-agent reply IS Cursor's own plan paywall — "Upgrade your
 * plan to continue". The user's CURSOR account has no active plan/credits to
 * run the agent. This is NOT a credential problem (the login works), so callers
 * do NOT flag the credential invalid or offer re-link; they point the user at
 * their Cursor account to upgrade. Length-guarded so a reply that merely
 * DISCUSSES plans isn't misclassified.
 *
 * Re-exported by `failure-messages.ts` (its original home) so existing import
 * sites and the runner re-export chain keep working unchanged.
 */
export function replyIsCursorUpgradeRequired(finalText: string): boolean {
  const t = finalText.trim().toLowerCase();
  if (t.length === 0 || t.length > 200) return false;
  return (
    t.includes('upgrade your plan to continue') ||
    (t.includes('upgrade your plan') && t.includes('continue'))
  );
}

/** True when a startup failure is Gemini's post-2026-06-18 free-tier death. */
function isGeminiIneligibleTier(haystack: string): boolean {
  return /IneligibleTierError|UNSUPPORTED_CLIENT|no longer supported for Gemini Code Assist|not eligible for Gemini Code Assist/i.test(
    haystack,
  );
}

/**
 * The per-agent hooks table. Every entry is OPTIONAL — an agent with no quirks
 * simply has no entry (or an entry with no hooks), and every consumer uses
 * optional chaining so the absence is a silent no-op.
 */
export const ACP_AGENT_HOOKS: Partial<Record<AgentId, AcpAgentHooks>> = {
  claude: {
    statusPage: { vendor: 'Anthropic', url: 'https://status.anthropic.com' },
    // Freeze the SDK-bundled Claude Code binary at the version this CLI (and its
    // pinned ACP adapter) was tested against. Without this the binary silently
    // self-updates to @latest and can drift PAST the adapter — a newer Claude
    // Code (v2.1.211) started streaming its TUI chrome (What's-new banner, status
    // line, box-drawing) into the ACP text channel, which paints as a broken chat
    // on mobile. A version regression must now reach users only through a gated
    // codeam-cli release, never silently via auto-update.
    startupExtraEnv: (): Record<string, string> => ({
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    }),
  },
  codex: {
    statusPage: { vendor: 'OpenAI', url: 'https://status.openai.com' },
    startupExtraEnv: ({ autoApprovePermissions }): Record<string, string> =>
      autoApprovePermissions ? { INITIAL_AGENT_MODE: 'agent-full-access' } : {},
  },
  gemini: {
    statusPage: { vendor: 'Google', url: 'https://status.cloud.google.com' },
    classifyStartupFailure: (haystack) =>
      isGeminiIneligibleTier(haystack) ? 'ineligible_tier' : null,
  },
  copilot: {
    statusPage: { vendor: 'GitHub', url: 'https://www.githubstatus.com' },
  },
  cursor: {
    statusPage: { vendor: 'Cursor', url: 'https://status.cursor.com' },
    classifyCompletedReply: (finalText) =>
      replyIsCursorUpgradeRequired(finalText) ? 'upgrade_required' : null,
  },
};

/**
 * Look up an agent's hooks. Accepts a plain string (callers hold `AgentId`
 * already, but `failure-messages.ts` types some params as `string`); an
 * unknown key returns `undefined` — a safe no-op for every consumer.
 */
export function agentHooks(agent: string): AcpAgentHooks | undefined {
  return ACP_AGENT_HOOKS[agent as AgentId];
}
