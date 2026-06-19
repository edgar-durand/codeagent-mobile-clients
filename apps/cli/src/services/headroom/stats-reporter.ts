// src/services/headroom/stats-reporter.ts
export interface Savings {
  rawTokensEst: number; sentTokensEst: number; cachedTokens: number; retrieveHops: number;
}

/**
 * Real shape returned by headroom-ai 0.26.0 GET /stats.
 * All fields are optional — read() applies optional chaining + ?? 0 throughout.
 */
export interface StatsShape {
  summary?: {
    compression?: {
      total_tokens_before_with_cli_filtering?: number;
      total_tokens_removed?: number;
    };
    mcp?: {
      retrievals?: number;
    };
  };
  agent_usage?: {
    totals?: {
      before_tokens?: number;
      after_tokens?: number;
    };
  };
}

const ZERO: Savings = { rawTokensEst: 0, sentTokensEst: 0, cachedTokens: 0, retrieveHops: 0 };

/**
 * Parse a /stats response into a Savings snapshot.
 * Primary source: agent_usage.totals (authoritative cumulative totals per agent).
 * Fallback:       summary.compression (used when agent_usage is absent).
 * cachedTokens:   /stats has no cached-token count — always 0.
 * retrieveHops:   summary.mcp.retrievals.
 */
function read(stats: StatsShape): Savings {
  const totals = stats.agent_usage?.totals;
  const compression = stats.summary?.compression;

  const rawTokensEst =
    totals?.before_tokens ??
    compression?.total_tokens_before_with_cli_filtering ??
    0;

  const sentTokensEst =
    totals?.after_tokens ??
    (rawTokensEst - (compression?.total_tokens_removed ?? 0));

  return {
    rawTokensEst,
    sentTokensEst,
    cachedTokens: 0,
    retrieveHops: stats.summary?.mcp?.retrievals ?? 0,
  };
}

/** Pure: turn a cumulative /stats reading into the next-cursor + the delta to
 *  report. Clamps negatives to 0 (a proxy restart resets the counters). */
export function mapStatsToSavings(stats: StatsShape, prev: Savings): { next: Savings; delta: Savings } {
  const next = read(stats);
  const d = (a: number, b: number) => Math.max(0, a - b);
  const delta: Savings = next.rawTokensEst < prev.rawTokensEst
    ? next // counter reset → report the post-reset reading as the delta
    : {
        rawTokensEst: d(next.rawTokensEst, prev.rawTokensEst),
        sentTokensEst: d(next.sentTokensEst, prev.sentTokensEst),
        cachedTokens: d(next.cachedTokens, prev.cachedTokens),
        retrieveHops: d(next.retrieveHops, prev.retrieveHops),
      };
  return { next, delta };
}

export interface ReporterDeps {
  fetchStats: () => Promise<StatsShape>;            // GET localhost:8787/stats
  postSavings: (delta: Savings) => Promise<void>;   // POST to the backend ingest endpoint
  intervalMs?: number;                              // default from HEADROOM_STATS_POLL_INTERVAL_MS or 30_000
}

/**
 * Scoped LOCAL reporter. This polls a localhost sidecar (not the backend SSE
 * path) for optional observability — it is the documented-exception kind of
 * poll, not real-time command delivery. Interval is tunable; default 30s.
 */
export class HeadroomStatsReporter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private prev: Savings = ZERO;
  constructor(private readonly deps: ReporterDeps) {}

  start(): void {
    const ms = this.deps.intervalMs
      ?? (Number(process.env.HEADROOM_STATS_POLL_INTERVAL_MS ?? '30000') || 30_000);
    this.timer = setInterval(() => void this.tick(), ms);
  }
  async tick(): Promise<void> {
    try {
      const { next, delta } = mapStatsToSavings(await this.deps.fetchStats(), this.prev);
      this.prev = next;
      if (delta.rawTokensEst > 0) await this.deps.postSavings(delta);
    } catch {
      /* best-effort observability — never throw from the reporter */
    }
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}
