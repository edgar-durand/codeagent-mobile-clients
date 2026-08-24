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
import { log } from '../../services/logger';

/**
 * WHY a credential is unusable. Optional on the wire (older backends ignore an
 * unknown field, and the CLI still reports without one), but it lets the app
 * render the RIGHT recovery copy:
 *
 *  - `'auth_failure'` — the provider returned a real runtime 401.
 *  - `'expired'`      — the local token is past its expiry and unrefreshable.
 *  - `'ineligible_tier'` — the ACCOUNT itself can never authenticate here, no
 *    matter how fresh the token is (Gemini's post-2026-06-18 free "Login with
 *    Google" deprecation). Re-running the SAME login can't fix it — the user
 *    must re-link with a different credential class (API key / paid tier).
 */
export type CredentialInvalidReason = 'ineligible_tier' | 'auth_failure' | 'expired';

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
    reason?: CredentialInvalidReason;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = `${resolveApiBaseUrl()}/api/plugin/agents/${encodeURIComponent(opts.agent)}/credential-invalid`;
  // `reason` is OMITTED when absent so the body stays byte-identical to the
  // pre-reason wire for every existing caller (old backends validate strictly).
  const body = JSON.stringify({
    sessionId: opts.sessionId,
    pluginId: opts.pluginId,
    ...(opts.reason ? { reason: opts.reason } : {}),
  });
  // ⚠️ LOG IT. This used to run completely silently — no record that it fired,
  // for which agent, or what the backend said, and the catch swallowed
  // everything. When a user got a false "your credentials are invalid" bubble
  // (2026-08-24) the CLI logs held no trace of the report at all, so even with
  // shell access to the box there was no way to see what had triggered it.
  // Flagging a user's credential as dead is not a step that should be
  // invisible.
  log.info(
    'acpRunner',
    `credential-invalid → reporting agent=${opts.agent} reason=${opts.reason ?? 'unspecified'}`,
  );
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
        const retried = await fetchImpl(url, {
          method: 'POST',
          headers: makeHeaders(freshToken),
          body,
        });
        log.info('acpRunner', `credential-invalid ← ${retried.status} (after token refresh)`);
        return;
      }
    }
    log.info('acpRunner', `credential-invalid ← ${response.status}`);
  } catch (err) {
    // Best-effort — credential recovery must never break the runner. But say so.
    log.warn(
      'acpRunner',
      `credential-invalid → failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Best-effort: push the user's FRESH local agent credential to the vault so a
 * LATER deploy injects a currently-valid token instead of a stale one. Fired by
 * the credential-sync watcher when the local agent rotates its OAuth token on an
 * active session (Anthropic single-use refresh tokens → the vaulted snapshot
 * goes stale → "Claude creds expired on a new deploy"). The backend auto-creates
 * the LinkedAgent when none exists and never clobbers a durable setup-token, so
 * this is safe to fire broadly. Never throws — a sync failure must not break the
 * session. `fetchImpl` injectable for tests.
 */
export async function postCredentialSync(
  opts: {
    agent: string;
    sessionId: string;
    pluginId: string;
    pluginAuthToken: string;
    method: 'oauth' | 'setup_token';
    credential: string;
    agentState?: string;
    pollSecret?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = `${resolveApiBaseUrl()}/api/plugin/agents/${encodeURIComponent(opts.agent)}/credential-sync`;
  const body = JSON.stringify({
    sessionId: opts.sessionId,
    pluginId: opts.pluginId,
    method: opts.method,
    credential: opts.credential,
    ...(opts.agentState ? { agentState: opts.agentState } : {}),
  });
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
    // Best-effort — keeping the vault fresh must never break the session.
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
