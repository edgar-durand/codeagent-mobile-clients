// src/services/headroom/stats-reporter.ts
export interface Savings {
  rawTokensEst: number;
  sentTokensEst: number;
  cachedTokens: number;
  retrieveHops: number;
  /** PROMPT-CACHE dimension — the dominant saving for BYO coding agents
   *  (Claude Code etc.), which compress ~nothing (tool outputs are protected)
   *  but serve a large repeated prefix from the provider's prompt cache.
   *  `cacheReadTokens` is cumulative cache-read tokens; `cacheSavingsUsd` is
   *  the proxy's own computed cost saving (real model price). Distinct from
   *  `cachedTokens` (which feeds the compression dollar formula server-side). */
  cacheReadTokens: number;
  cacheSavingsUsd: number;
  /** COMPRESSION dollar saving — the eliminated (rawTokensEst − sentTokensEst)
   *  tokens valued at the agent model's INPUT price. The proxy doesn't expose
   *  this (only cache_savings_usd), so the reporter computes it from the token
   *  delta × `inputPricePerMillionUsd`. The backend sums it with cacheSavingsUsd
   *  into the per-session CostSaving.usdSaved. */
  compressionSavingsUsd: number;
}

/** Claude Sonnet input $/M — the default when the agent's price is unknown. */
const DEFAULT_INPUT_PRICE_PER_MILLION = 3;

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
    cost?: {
      breakdown?: {
        cache_savings_usd?: number;
      };
    };
  };
  agent_usage?: {
    totals?: {
      before_tokens?: number;
      after_tokens?: number;
    };
  };
  /** Top-level prefix-cache block (NOT under summary). */
  prefix_cache?: {
    totals?: {
      cache_read_tokens?: number;
    };
  };
}

const ZERO: Savings = {
  rawTokensEst: 0,
  sentTokensEst: 0,
  cachedTokens: 0,
  retrieveHops: 0,
  cacheReadTokens: 0,
  cacheSavingsUsd: 0,
  compressionSavingsUsd: 0,
};

/**
 * Parse a /stats response into a Savings snapshot.
 * Primary source: agent_usage.totals (authoritative cumulative totals per agent).
 * Fallback:       summary.compression (used when agent_usage is absent).
 * cachedTokens:   compression-cache count — not exposed; always 0.
 * retrieveHops:   summary.mcp.retrievals.
 * cacheReadTokens: prefix_cache.totals.cache_read_tokens (prompt-cache reads).
 * cacheSavingsUsd: summary.cost.breakdown.cache_savings_usd (proxy-computed $).
 */
function read(stats: StatsShape, inputPricePerMillion: number): Savings {
  const totals = stats.agent_usage?.totals;
  const compression = stats.summary?.compression;

  const rawTokensEst =
    totals?.before_tokens ??
    compression?.total_tokens_before_with_cli_filtering ??
    0;

  const sentTokensEst =
    totals?.after_tokens ??
    (rawTokensEst - (compression?.total_tokens_removed ?? 0));

  // Cumulative compression $: eliminated tokens × the model's input price.
  // Cumulative (like raw/sent) so mapStatsToSavings can diff it into a delta.
  const compressionSavingsUsd =
    (Math.max(0, rawTokensEst - sentTokensEst) / 1_000_000) * inputPricePerMillion;

  return {
    rawTokensEst,
    sentTokensEst,
    cachedTokens: 0,
    retrieveHops: stats.summary?.mcp?.retrievals ?? 0,
    cacheReadTokens: stats.prefix_cache?.totals?.cache_read_tokens ?? 0,
    cacheSavingsUsd: stats.summary?.cost?.breakdown?.cache_savings_usd ?? 0,
    compressionSavingsUsd,
  };
}

/** Pure: turn a cumulative /stats reading into the next-cursor + the delta to
 *  report. Clamps negatives to 0 (a proxy restart resets the counters). */
export function mapStatsToSavings(
  stats: StatsShape,
  prev: Savings,
  inputPricePerMillion: number = DEFAULT_INPUT_PRICE_PER_MILLION,
): { next: Savings; delta: Savings } {
  const next = read(stats, inputPricePerMillion);
  const d = (a: number, b: number) => Math.max(0, a - b);
  const delta: Savings = next.rawTokensEst < prev.rawTokensEst
    ? next // counter reset → report the post-reset reading as the delta
    : {
        rawTokensEst: d(next.rawTokensEst, prev.rawTokensEst),
        sentTokensEst: d(next.sentTokensEst, prev.sentTokensEst),
        cachedTokens: d(next.cachedTokens, prev.cachedTokens),
        retrieveHops: d(next.retrieveHops, prev.retrieveHops),
        cacheReadTokens: d(next.cacheReadTokens, prev.cacheReadTokens),
        cacheSavingsUsd: d(next.cacheSavingsUsd, prev.cacheSavingsUsd),
        compressionSavingsUsd: d(next.compressionSavingsUsd, prev.compressionSavingsUsd),
      };
  return { next, delta };
}

export interface ReporterDeps {
  fetchStats: () => Promise<StatsShape>;            // GET localhost:8787/stats
  postSavings: (delta: Savings) => Promise<void>;   // POST to the backend ingest endpoint
  intervalMs?: number;                              // default from HEADROOM_STATS_POLL_INTERVAL_MS or 30_000
  /** Input $/M for the running agent's model — values the compressed-away
   *  tokens. Defaults to Claude Sonnet ($3/M) when the caller can't resolve it. */
  inputPricePerMillionUsd?: number;
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
      const { next, delta } = mapStatsToSavings(
        await this.deps.fetchStats(),
        this.prev,
        this.deps.inputPricePerMillionUsd ?? DEFAULT_INPUT_PRICE_PER_MILLION,
      );
      this.prev = next;
      // Report when ANY dimension advanced — a BYO coding agent compresses
      // ~nothing (rawTokensEst flat) yet still accrues prompt-cache savings, so
      // gating only on rawTokensEst would never report the cache dimension.
      if (
        delta.rawTokensEst > 0 ||
        delta.cacheReadTokens > 0 ||
        delta.cacheSavingsUsd > 0 ||
        delta.compressionSavingsUsd > 0
      ) {
        await this.deps.postSavings(delta);
      }
    } catch {
      /* best-effort observability — never throw from the reporter */
    }
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}
