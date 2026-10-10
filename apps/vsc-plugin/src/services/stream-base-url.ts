/**
 * Stream-tier base URL — the VS Code extension's half of the backend's
 * api/stream host split (same rule as the CLI's `stream-base-url.ts`).
 *
 * The backend runs two Cloud Run tiers behind two hostnames: `api.` (REST)
 * and `stream.` (the long-lived SSE routes). Route PATHS never change, only
 * the base URL, so the extension needs one rule: which base its
 * `/api/commands/pending/stream` subscription opens against.
 *
 *   - `https://api.codeagent-mobile.com`     → `https://stream.codeagent-mobile.com`
 *   - `https://dev-api.codeagent-mobile.com` → `https://dev-stream.codeagent-mobile.com`
 *   - anything else (a custom `apiBaseUrl`, localhost) → the api base unchanged.
 *
 * WHY this exists (bead codeagent-8x0e.9): once prod's api tier runs with
 * `SERVICE_ROLE=api` it answers 404 on the stream routes. An extension that
 * kept opening the stream on `apiBaseUrl` would take two 404s and drop to
 * polling for good — a 2 s poll loop on the api tier, which FREE plans
 * rate-limit at 12/min.
 *
 * One-time fallback: if the FIRST contact with the stream host fails with a
 * network error or a 5xx before a byte arrived, the extension latches onto
 * the api base until `apiBaseUrl` changes. 401/403/404 never trigger it
 * (masking an `api`-role 404 would hide a misconfiguration), and a stream
 * that delivered and then dropped is a normal reconnect.
 *
 * Kept local on purpose: each client owns its own copy of this URL rule
 * (stream split spec §4.2).
 */
import { DEFAULT_API_BASE_URL, DEV_API_BASE_URL } from '@codeam/shared';

export const DEFAULT_STREAM_BASE_URL = 'https://stream.codeagent-mobile.com' as const;
export const DEV_STREAM_BASE_URL = 'https://dev-stream.codeagent-mobile.com' as const;

const STREAM_HOST_FOR_API_HOST: Readonly<Record<string, string>> = {
  [DEFAULT_API_BASE_URL]: DEFAULT_STREAM_BASE_URL,
  [DEV_API_BASE_URL]: DEV_STREAM_BASE_URL,
};

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

export function resolveStreamBaseUrl(apiBase: string): string {
  const base = stripTrailingSlashes(apiBase);
  return STREAM_HOST_FOR_API_HOST[base] ?? base;
}

export type StreamHostFailure = { kind: 'network' } | { kind: 'status'; status: number };

export function shouldFallBackToApiHost(failure: StreamHostFailure, delivered: boolean): boolean {
  if (delivered) return false;
  if (failure.kind === 'network') return true;
  return failure.status >= 500;
}

/**
 * "Which base does the next stream connection use" latch. Keyed on the api
 * base it was resolved for, so a mid-session `apiBaseUrl` change re-derives
 * the stream host and clears a previous fallback.
 */
export class StreamHostSelector {
  private apiBase: string | null = null;
  private fellBackToApi = false;

  currentFor(apiBase: string): string {
    const base = stripTrailingSlashes(apiBase);
    if (base !== this.apiBase) {
      this.apiBase = base;
      this.fellBackToApi = false;
    }
    return this.fellBackToApi ? base : resolveStreamBaseUrl(base);
  }

  /**
   * Record a failure against `apiBase`'s stream host. Returns `true` exactly
   * once — on the failure that moves the extension onto the api base — so
   * the caller reconnects immediately without spending its polling budget.
   */
  fallBackToApiHost(apiBase: string, failure: StreamHostFailure, delivered: boolean): boolean {
    const base = stripTrailingSlashes(apiBase);
    if (this.currentFor(base) === base) return false;
    if (!shouldFallBackToApiHost(failure, delivered)) return false;
    this.fellBackToApi = true;
    return true;
  }
}
