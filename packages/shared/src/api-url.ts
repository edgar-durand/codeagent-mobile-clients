/**
 * Production API base URL for all CodeAgent Mobile clients.
 *
 * History note: prod migrated from Vercel (`https://api.codeagent-mobile.com`)
 * to Cloud Run / api-v2 (`https://api.codeagent-mobile.com`) in 2026-05. The
 * Vercel deployment is now gated by Vercel deployment protection and returns
 * 403 for unauthed traffic — DO NOT fall back to it.
 *
 * Override at runtime with `CODEAM_API_URL` (full URL override) OR set
 * `CODEAM_TEST_MODE=1` to point every client request at the dev
 * preview without having to know its host.
 */
export const DEFAULT_API_BASE_URL = 'https://api.codeagent-mobile.com' as const;

/**
 * Dev-preview API base URL. Same Cloud Run service as prod but routed
 * to the `dev` revision (auto-deploys from the `dev` branch in the
 * backend repo). Manual smoke tests + load runs land here.
 */
export const DEV_API_BASE_URL = 'https://dev-api.codeagent-mobile.com' as const;

/**
 * Resolve the active API base URL, honoring in priority order:
 *
 *   1. Explicit `CODEAM_API_URL` env var — full URL, takes precedence.
 *   2. `CODEAM_TEST_MODE=1` shortcut — flips to [DEV_API_BASE_URL]
 *      without the user having to know the dev host.
 *   3. The `DEFAULT_API_BASE_URL` constant (prod).
 *
 * Used by every CLI service that talks to the backend so one env var
 * flips heartbeats, command relay, chunk uploads, and the pairing
 * flow in lockstep — eliminates the cross-environment misroute where
 * pairing succeeds in dev (shared Redis) but the CLI keeps
 * heartbeating to prod.
 */
export function resolveApiBaseUrl(): string {
  // Guard against non-Node runtimes (browser bundles import this
  // module). `process` is undefined there; treat as prod default.
  // `@codeagent/shared` deliberately avoids depending on `@types/node`
  // so its types stay consumable from the mobile RN bundle too, so we
  // reach for the env via a structural cast rather than NodeJS.ProcessEnv.
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const explicit = env?.CODEAM_API_URL?.trim();
  if (explicit) return explicit;
  const testFlag = env?.CODEAM_TEST_MODE?.trim();
  if (testFlag === '1' || testFlag?.toLowerCase() === 'true') return DEV_API_BASE_URL;
  return DEFAULT_API_BASE_URL;
}
