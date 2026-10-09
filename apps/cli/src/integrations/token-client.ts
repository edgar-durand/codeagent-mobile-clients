// src/integrations/token-client.ts
//
// Broker token client for Agent Toolkits integrations: exchanges the
// session's plugin-auth token for a short-lived (~1h) integration access
// token via `POST /api/plugin/integrations/:id/token`. Follows the
// `backend-reports.ts` fetch + single 401/403 retry pattern, plus an
// in-memory refresh-ahead cache so repeated calls within the TTL don't
// re-hit the network.
import { z } from 'zod';
import { resolveApiBaseUrl } from '@codeam/shared';
import type { BrokeredIntegrationToken } from '@codeam/shared';
import { fetchCurrentPluginAuthToken } from '../services/pairing.service';

/** Refresh a cached token this far ahead of its expiry rather than risk a stale-token 401 mid-turn. */
const REFRESH_AHEAD_MS = 5 * 60 * 1000;

/**
 * The broker's 200 body. Validated because the token feeds straight into a
 * spawned server's env and the refresh schedule: a malformed body used to be
 * cached as-is, and `childEnvFor` / `expiresAt` math then failed far from the
 * cause (codeagent-sjk d). Only the fields every integration needs are
 * required; the per-vendor extras (`cloudId`, `host`, …) pass through.
 */
const BrokeredTokenResponseSchema = z.object({
  success: z.literal(true),
  data: z
    .object({
      accessToken: z.string().min(1),
      expiresAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not a date'),
    })
    .catchall(z.unknown()),
});

export interface BrokerCtx {
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  pollSecret?: string;
}

export class IntegrationTokenClient {
  private readonly cache = new Map<string, BrokeredIntegrationToken>();
  private token: string;

  constructor(
    private readonly ctx: BrokerCtx,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.token = ctx.pluginAuthToken;
  }

  /**
   * Fetch (or return the cached) broker token for `integrationId`.
   * Throws `Error(<code>)` on a non-retryable / still-failing 4xx-5xx.
   */
  async getToken(integrationId: string): Promise<BrokeredIntegrationToken> {
    const cached = this.cache.get(integrationId);
    if (cached && new Date(cached.expiresAt).getTime() - Date.now() > REFRESH_AHEAD_MS) {
      return cached;
    }

    const url = `${resolveApiBaseUrl()}/api/plugin/integrations/${encodeURIComponent(integrationId)}/token`;
    const body = JSON.stringify({ sessionId: this.ctx.sessionId, pluginId: this.ctx.pluginId });
    const post = (tok: string) =>
      this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Plugin-Auth-Token': tok },
        body,
      });

    let resp = await post(this.token);
    if (resp.status === 401 || resp.status === 403) {
      const fresh = await fetchCurrentPluginAuthToken(
        this.ctx.sessionId,
        this.ctx.pluginId,
        this.ctx.pollSecret,
      );
      if (fresh !== null) {
        this.token = fresh;
        resp = await post(fresh);
      }
    }

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      // Truncate: a verbose backend error body (HTML page, stack trace) must not
      // flow unbounded into an Error message that downstream code logs.
      throw new Error(`INTEGRATION_TOKEN_FAILED status=${resp.status} ${detail.slice(0, 200)}`.trim());
    }

    const parsed = BrokeredTokenResponseSchema.safeParse(await resp.json().catch(() => null));
    if (!parsed.success) {
      throw new Error(`INTEGRATION_TOKEN_MALFORMED ${parsed.error.issues[0]?.message ?? ''}`.trim());
    }
    // Validated boundary: the required fields are checked above, the optional
    // per-vendor ones are carried through as the broker sent them.
    const token = parsed.data.data as BrokeredIntegrationToken;
    this.cache.set(integrationId, token);
    return token;
  }
}
