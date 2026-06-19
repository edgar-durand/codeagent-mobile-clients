// src/services/headroom/stats-reporter.ts
export interface Savings {
  rawTokensEst: number; sentTokensEst: number; cachedTokens: number; retrieveHops: number;
}

interface StatsShape {
  // VERIFY field names against `curl localhost:8787/stats` (see VERIFY-THEN-MAP in task brief).
  // The exact names inside `persistent_savings` must be confirmed against a running proxy;
  // adjust this one function after the curl check — the rest of the code is isolated from them.
  persistent_savings?: {
    tokens_before?: number; tokens_after?: number; cached_tokens?: number; retrieve_hops?: number;
  };
}

const ZERO: Savings = { rawTokensEst: 0, sentTokensEst: 0, cachedTokens: 0, retrieveHops: 0 };

function read(stats: StatsShape): Savings {
  const p = stats.persistent_savings ?? {};
  return {
    rawTokensEst: p.tokens_before ?? 0,
    sentTokensEst: p.tokens_after ?? 0,
    cachedTokens: p.cached_tokens ?? 0,
    retrieveHops: p.retrieve_hops ?? 0,
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
