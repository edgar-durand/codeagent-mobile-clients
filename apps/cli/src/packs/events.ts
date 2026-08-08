import { resolveApiBaseUrl, type PackRunState } from '@codeam/shared';
import { fetchCurrentPluginAuthToken } from '../services/pairing.service';

/**
 * Best-effort pack lifecycle POST — the backend republishes `pack_state` on the
 * per-user SSE bus + snapshots it into Redis (`pack:<sessionId>`, the
 * preview/baton pattern). Mirrors `backend-reports.ts`: never throws, one
 * fresh-token retry on 401/403. The workspace ledger stays the source of truth;
 * a lost POST costs a UI refresh, never run state.
 */
export async function postPackState(
  opts: {
    sessionId: string;
    pluginId: string;
    pluginAuthToken: string;
    pollSecret?: string;
  },
  state: PackRunState,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = `${resolveApiBaseUrl()}/api/packs/events`;
  const body = JSON.stringify({ sessionId: opts.sessionId, pluginId: opts.pluginId, state });
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
    // Best-effort — a failed state POST must never break the pipeline.
  }
}
