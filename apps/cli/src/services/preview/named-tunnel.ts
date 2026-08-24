import { log } from '../logger';

/**
 * Resolving the NAMED preview tunnel — our own zone, not `*.trycloudflare.com`.
 *
 * WHY THIS EXISTS — codeagent-xsot. The backend used to mint a named tunnel
 * only while provisioning a codespace, exporting it as `PREVIEW_TUNNEL_TOKEN` /
 * `PREVIEW_TUNNEL_HOSTNAME`. A CodeAgent Box, a self-hosted host and the SHARED
 * DEMO SESSION got neither — verified on the demo box, both empty in the live
 * process env — so every preview they served rode a quick tunnel. That is the
 * hostname whose DNS-propagation window left the web preview panel blank for
 * the whole time a user waited on it (replay 01a03418), and which some networks
 * filter outright.
 *
 * The backend now mints one on demand, so this asks for it when the
 * environment did not already provide one. Asking at PREVIEW START rather than
 * at deploy is deliberate on both sides: each named tunnel costs a DNS record
 * against Cloudflare Free's 200-record cap, and minting per session is exactly
 * what filled that cap in 2026-08 — after which every create failed and
 * everyone fell back to quick tunnels regardless.
 */
export interface NamedTunnelContext {
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
}

export interface NamedTunnel {
  token: string;
  hostname: string;
}

/** Fetches a freshly minted tunnel from the backend. Injected for tests. */
export type TunnelFetcher = (
  ctx: NamedTunnelContext,
) => Promise<{ hostname: string; token: string } | null>;

/**
 * The named tunnel to use, or null to fall back to a quick tunnel.
 *
 * Environment first: the codespace bootstrap already exported one, and a
 * round-trip there would be pure latency on the preview's critical path.
 *
 * NEVER throws. Every failure — no tunnel available, a backend that predates
 * the route, a network blip, a half-filled reply — resolves to null, because
 * the caller's quick-tunnel fallback is a perfectly good answer. A preview on a
 * flaky hostname beats no preview at all.
 */
export async function resolveNamedTunnel(
  ctx: NamedTunnelContext,
  fetchTunnel: TunnelFetcher,
): Promise<NamedTunnel | null> {
  const envToken = process.env.PREVIEW_TUNNEL_TOKEN;
  const envHostname = process.env.PREVIEW_TUNNEL_HOSTNAME;
  if (envToken && envHostname) return { token: envToken, hostname: envHostname };

  // The route is plugin-auth gated; calling it unauthenticated can only 401.
  if (!ctx.pluginAuthToken) return null;

  try {
    const minted = await fetchTunnel(ctx);
    if (!minted?.token || !minted.hostname) return null;
    log.info('preview', `named tunnel minted on demand: ${minted.hostname}`);
    return { token: minted.token, hostname: minted.hostname };
  } catch (err) {
    // Includes the 404 from a backend deployed before this route existed —
    // not an error state, just an older deployment.
    log.trace(
      'preview',
      `named tunnel unavailable (${err instanceof Error ? err.message : String(err)}) — quick tunnel`,
    );
    return null;
  }
}
