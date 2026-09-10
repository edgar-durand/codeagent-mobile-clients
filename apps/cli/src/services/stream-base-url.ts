/**
 * Stream-tier base URL — the CLI half of the backend's api/stream host split.
 *
 * The backend now runs two Cloud Run tiers behind two hostnames: `api.` (REST
 * + everything else) and `stream.` (the four long-lived SSE routes). Routing
 * is by host — **route PATHS never change, only the base URL** — so the CLI
 * needs exactly one rule: which base to open its SSE streams against.
 *
 *   - `https://api.codeagent-mobile.com`     → `https://stream.codeagent-mobile.com`
 *   - `https://dev-api.codeagent-mobile.com` → `https://dev-stream.codeagent-mobile.com`
 *   - anything else (localhost, a custom `CODEAM_API_URL`, an unknown host)
 *     → the api base unchanged, so self-hosted / dev-loop setups keep working
 *     byte-for-byte.
 *   - an explicit `CODEAM_STREAM_URL` wins over the rule.
 *
 * Only `GET /api/commands/pending/stream` moves (the relay's command channel
 * and the pre-pair `pair_completed` subscriber). Every REST call — acks,
 * results, heartbeats, `/pairing/*`, the `/commands/pending` polling
 * fallback — stays on the api base.
 *
 * **One-time fallback.** The stream host may not exist yet (prod's
 * `stream.` record answers 525 until its origin ships) or may be down while
 * `api.` is fine. So if the FIRST contact with the stream host fails with a
 * network error or a 5xx — before a single byte was delivered — the process
 * latches onto the api base for its remaining lifetime (the main service
 * keeps serving the streams in role `all` until telemetry says every client
 * has moved). Auth verdicts (401/403) and 404 never trigger it: an `api`-role
 * tier answers 404 on the stream routes and masking that would hide a real
 * misconfiguration. Delivered-then-dropped is a normal reconnect on the
 * stream host. This runs BEFORE the relay's SSE → polling fallback, so the
 * ladder is: stream host → api host → polling.
 *
 * Kept local to the CLI on purpose (no `@codeam/shared` dependency for a URL
 * rule — each client owns its own copy; spec §4.2).
 */
import { DEFAULT_API_BASE_URL, DEV_API_BASE_URL, resolveApiBaseUrl } from '@codeam/shared';

export const DEFAULT_STREAM_BASE_URL = 'https://stream.codeagent-mobile.com' as const;
export const DEV_STREAM_BASE_URL = 'https://dev-stream.codeagent-mobile.com' as const;

const STREAM_HOST_FOR_API_HOST: Readonly<Record<string, string>> = {
  [DEFAULT_API_BASE_URL]: DEFAULT_STREAM_BASE_URL,
  [DEV_API_BASE_URL]: DEV_STREAM_BASE_URL,
};

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Pure host rule. `override` is the raw `CODEAM_STREAM_URL` value: blank
 * means unset. Trailing slashes are tolerated on both inputs so callers can
 * always append `/api/...`.
 */
export function resolveStreamBaseUrl(apiBase: string, override?: string): string {
  const explicit = override?.trim();
  if (explicit) return stripTrailingSlashes(explicit);
  const base = stripTrailingSlashes(apiBase);
  return STREAM_HOST_FOR_API_HOST[base] ?? base;
}

/**
 * Env-driven resolution, mirroring `resolveApiBaseUrl()`'s precedence:
 * `CODEAM_STREAM_URL` (explicit) → the host rule applied to whatever
 * `resolveApiBaseUrl()` produced (`CODEAM_API_URL` → `CODEAM_TEST_MODE` → prod).
 */
export function resolveStreamBaseUrlFromEnv(apiBase: string = resolveApiBaseUrl()): string {
  return resolveStreamBaseUrl(apiBase, process.env.CODEAM_STREAM_URL);
}

export type StreamHostFailure = { kind: 'network' } | { kind: 'status'; status: number };

/**
 * The fallback verdict, kept pure so the table is testable on its own:
 * a network error or a 5xx before anything was delivered → fall back;
 * every 4xx (auth, 404 from an `api`-role tier, rate limit) → never;
 * anything after delivery → never (normal reconnect).
 */
export function shouldFallBackToApiHost(failure: StreamHostFailure, delivered: boolean): boolean {
  if (delivered) return false;
  if (failure.kind === 'network') return true;
  return failure.status >= 500;
}

export function describeStreamHostFailure(failure: StreamHostFailure): string {
  return failure.kind === 'network' ? 'network' : `status_${failure.status}`;
}

/**
 * Process-wide "which base do streams open against" latch. One instance is
 * shared by every SSE subscriber in the process (`streamHost` below) so a
 * fallback taken while pairing is honoured by the relay that starts right
 * after — "for the rest of the process" means the process, not the caller.
 */
export class StreamHostSelector {
  private fellBackToApi = false;

  constructor(
    private readonly apiBase: string,
    private readonly streamBase: string,
  ) {}

  /** Base URL the next stream connection must use. */
  get current(): string {
    return this.fellBackToApi ? this.apiBase : this.streamBase;
  }

  get fellBack(): boolean {
    return this.fellBackToApi;
  }

  /**
   * Record a failure on the CURRENT base. Returns `true` exactly once — on
   * the failure that moves the process onto the api base — so the caller
   * can log/emit telemetry a single time and reconnect immediately. Always
   * `false` when there is nothing to fall back to (stream base == api base,
   * or already fallen back).
   */
  fallBackToApiHost(failure: StreamHostFailure, delivered: boolean): boolean {
    if (this.fellBackToApi || this.streamBase === this.apiBase) return false;
    if (!shouldFallBackToApiHost(failure, delivered)) return false;
    this.fellBackToApi = true;
    return true;
  }
}

/** The process-wide selector, resolved once at import like `API_BASE` is. */
export const streamHost = new StreamHostSelector(
  resolveApiBaseUrl(),
  resolveStreamBaseUrlFromEnv(),
);
