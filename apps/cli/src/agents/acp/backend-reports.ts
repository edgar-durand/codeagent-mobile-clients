/**
 * Best-effort backend notification POSTs shared by the ACP runner and the
 * per-command handlers.
 *
 * Extracted VERBATIM from `runner.ts` (Phase 3 refactor, bd codeagent-2sa) so
 * `command-handlers.ts` and `runner.ts` can both call them without a runtime
 * import cycle. Both helpers are fire-and-forget by contract: they NEVER throw
 * into the caller — a failed report must not break a turn or the session.
 */

import { resolveApiBaseUrl } from '@codeam/shared';
import { fetchCurrentPluginAuthToken } from '../../services/pairing.service';

/**
 * Best-effort durable flag: tell the backend this LinkedAgent credential is
 * invalid so Profile › Agents shows EXPIRED + the re-auth CTA (instead of
 * CONNECTED from a dead-but-present refresh token). Never throws — credential
 * recovery must not break the runner. `fetchImpl` is injectable for tests.
 */
export async function reportCredentialInvalid(
  opts: {
    agent: string;
    sessionId: string;
    pluginId: string;
    pluginAuthToken: string;
    pollSecret?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = `${resolveApiBaseUrl()}/api/plugin/agents/${encodeURIComponent(opts.agent)}/credential-invalid`;
  const body = JSON.stringify({ sessionId: opts.sessionId, pluginId: opts.pluginId });
  try {
    const makeHeaders = (token: string): Record<string, string> => ({
      'Content-Type': 'application/json',
      'X-Plugin-Auth-Token': token,
    });

    const response = await fetchImpl(url, {
      method: 'POST',
      headers: makeHeaders(opts.pluginAuthToken),
      body,
    });

    if (response.status === 401 || response.status === 403) {
      const freshToken = await fetchCurrentPluginAuthToken(
        opts.sessionId,
        opts.pluginId,
        opts.pollSecret,
      );
      if (freshToken !== null) {
        await fetchImpl(url, { method: 'POST', headers: makeHeaders(freshToken), body });
      }
    }
  } catch {
    // Best-effort — credential recovery must never break the runner.
  }
}

/**
 * Fire-once best-effort POST to `POST /api/sessions/:sessionId/headroom-budget-reached`
 * when the local Headroom proxy 429s a turn due to budget exhaustion.
 *
 * Mirrors the `reportCredentialInvalid` pattern: injectable `fetchImpl` for
 * testing, never throws into the caller (the budget 429 must still surface a
 * recovery bubble regardless of whether this POST succeeds). Idempotency is the
 * backend's responsibility; the CLI fires it once per detected budget-exceeded
 * turn (de-duplication via `_budgetReachedPosted` in the runner closure).
 */
export async function postBudgetReached(
  opts: {
    sessionId: string;
    pluginId: string;
    pluginAuthToken: string;
    agent: string;
    period: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = `${resolveApiBaseUrl()}/api/sessions/${encodeURIComponent(opts.sessionId)}/headroom-budget-reached`;
  try {
    await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Plugin-Auth-Token': opts.pluginAuthToken,
      },
      body: JSON.stringify({
        sessionId: opts.sessionId,
        pluginId: opts.pluginId,
        agent: opts.agent,
        period: opts.period,
      }),
    });
  } catch {
    // Best-effort — a budget notification failure must never break the runner.
  }
}
