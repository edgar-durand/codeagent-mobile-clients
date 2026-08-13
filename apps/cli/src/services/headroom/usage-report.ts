// src/services/headroom/usage-report.ts
//
// Pulls Headroom's durable token-usage history (`GET /stats-history`) off the
// local proxy and TRIMS it on-box into the `HeadroomUsageReport` wire shape.
//
// Contract verified empirically against a real proxy (headroom 0.27.0,
// schema_version 3, ~30k requests of history) — the published docs omit the
// schema and wrongly imply there is no per-model breakdown.
//
// Why we trim here instead of relaying the raw payload:
//   • size — the default response is ~150 KB and `?history_mode=full` is
//     ~1.1 MB; dropping the raw `history[]` and capping the hourly series puts
//     it at ~23 KB, which the command relay carries comfortably.
//   • fidelity — `history[]` holds CUMULATIVE counters that a client would have
//     to diff, while `series[]` already carries per-bucket deltas plus the
//     `by_model` / `by_provider` split (richer than Headroom's own CSV export,
//     which has no model column).
//   • privacy — the proxy echoes `storage_path`, a local filesystem path that
//     includes the OS username. It never leaves the box.
//
// ⚠️ `?series=<name>` is IGNORED by the proxy (0.27.0 returns the identical
// 150 KB body), so there is no server-side way to ask for one granularity —
// the capping below is the only lever.

import { HEADROOM_PROXY_PORT } from '@codeam/shared';
import type {
  HeadroomUsageBucket,
  HeadroomUsageGranularity,
  HeadroomUsageReport,
  HeadroomUsageTotals,
} from '@codeam/shared';
import { log } from '../logger';

/** Most recent hourly buckets to keep. 48 h of detail at ~250 B/bucket. */
const HOURLY_CAP = 48;
/** Bound every other series too — a year of daily is still small, but finite. */
const SERIES_CAP: Record<HeadroomUsageGranularity, number> = {
  hourly: HOURLY_CAP,
  daily: 90,
  weekly: 52,
  monthly: 24,
};

const REQUEST_TIMEOUT_MS = 5_000;

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function totals(raw: unknown): HeadroomUsageTotals {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    requests: num(o.requests),
    tokens_saved: num(o.tokens_saved),
    compression_savings_usd: num(o.compression_savings_usd),
    total_input_tokens: num(o.total_input_tokens),
    total_input_cost_usd: num(o.total_input_cost_usd),
  };
}

function slices(raw: unknown): Record<string, HeadroomUsageBucket['by_model'][string]> {
  const out: Record<string, HeadroomUsageBucket['by_model'][string]> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const v = (value ?? {}) as Record<string, unknown>;
    out[key] = {
      tokens_saved: num(v.tokens_saved),
      compression_savings_usd_delta: num(v.compression_savings_usd_delta),
      total_input_tokens_delta: num(v.total_input_tokens_delta),
      total_input_cost_usd_delta: num(v.total_input_cost_usd_delta),
    };
  }
  return out;
}

function bucket(raw: unknown): HeadroomUsageBucket | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.timestamp !== 'string') return null;
  return {
    timestamp: o.timestamp,
    tokens_saved: num(o.tokens_saved),
    compression_savings_usd_delta: num(o.compression_savings_usd_delta),
    total_tokens_saved: num(o.total_tokens_saved),
    compression_savings_usd: num(o.compression_savings_usd),
    total_input_tokens_delta: num(o.total_input_tokens_delta),
    total_input_tokens: num(o.total_input_tokens),
    total_input_cost_usd_delta: num(o.total_input_cost_usd_delta),
    total_input_cost_usd: num(o.total_input_cost_usd),
    by_provider: slices(o.by_provider),
    by_model: slices(o.by_model),
  };
}

/**
 * Map the proxy's raw `/stats-history` body onto the trimmed wire report.
 * Exported for unit tests — every field is optional-chained so a future schema
 * bump degrades to zeros rather than throwing.
 */
export function toUsageReport(raw: unknown, proxyVersion?: string): HeadroomUsageReport {
  const root = (raw ?? {}) as Record<string, unknown>;
  const rawSeries = (root.series ?? {}) as Record<string, unknown>;

  const series: HeadroomUsageReport['series'] = {};
  for (const key of Object.keys(SERIES_CAP) as HeadroomUsageGranularity[]) {
    const arr = rawSeries[key];
    if (!Array.isArray(arr)) continue;
    // Keep the MOST RECENT buckets — the proxy returns oldest-first.
    const kept = arr.slice(-SERIES_CAP[key]).map(bucket).filter((b): b is HeadroomUsageBucket => b !== null);
    if (kept.length > 0) series[key] = kept;
  }

  const displaySession = (root.display_session ?? null) as Record<string, unknown> | null;
  const retention = (root.retention ?? null) as Record<string, unknown> | null;

  const report: HeadroomUsageReport = {
    schemaVersion: num(root.schema_version),
    generatedAt:
      typeof root.generated_at === 'string' ? root.generated_at : new Date().toISOString(),
    lifetime: totals(root.lifetime),
    series,
  };
  if (proxyVersion) report.proxyVersion = proxyVersion;
  if (displaySession) {
    report.currentSession = {
      ...totals(displaySession),
      savings_percent: num(displaySession.savings_percent),
      started_at: typeof displaySession.started_at === 'string' ? displaySession.started_at : null,
      last_activity_at:
        typeof displaySession.last_activity_at === 'string'
          ? displaySession.last_activity_at
          : null,
    };
  }
  if (retention) {
    report.retention = {
      max_history_points: num(retention.max_history_points),
      max_history_age_days: num(retention.max_history_age_days),
    };
  }
  // NOTE: `history[]` and `storage_path` are deliberately NOT carried over.
  return report;
}

export interface UsageReportDeps {
  /** Injectable for tests; defaults to the real proxy on loopback. */
  fetchJson?: (path: string) => Promise<unknown>;
  port?: number;
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as unknown;
}

/**
 * Read the trimmed usage report from the local proxy. Returns `null` (never
 * throws) when the proxy isn't running / doesn't expose the endpoint — the
 * caller turns that into an honest "not available" for the app.
 */
export async function readUsageReport(deps: UsageReportDeps = {}): Promise<HeadroomUsageReport | null> {
  const port = deps.port ?? HEADROOM_PROXY_PORT;
  const base = `http://127.0.0.1:${port}`;
  const get = deps.fetchJson ?? ((path: string) => defaultFetchJson(`${base}${path}`));

  let history: unknown;
  try {
    history = await get('/stats-history');
  } catch (err) {
    log.info('headroomUsage', `stats-history unavailable: ${(err as Error).message}`);
    return null;
  }

  // Best-effort proxy version for the UI footer — never fatal.
  let proxyVersion: string | undefined;
  try {
    const health = (await get('/health')) as { version?: unknown } | null;
    if (health && typeof health.version === 'string') proxyVersion = health.version;
  } catch {
    /* version is cosmetic */
  }

  return toUsageReport(history, proxyVersion);
}
