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
  /** COMPRESSION tokens saved — the proxy's authoritative headline number
   *  (`summary.compression.total_tokens_saved_with_cli_filtering`, = tokens
   *  removed by compression + CLI filtering). This is what the badge shows as
   *  "saved with Headroom". Falls back to (rawTokensEst − sentTokensEst). */
  compressionTokens: number;
  /** COMPRESSION dollar saving — the proxy's own
   *  `cost.breakdown.compression_savings_usd` (eliminated tokens at the model's
   *  LIST input price). When the proxy doesn't expose it, computed from
   *  `compressionTokens × inputPricePerMillionUsd`. The backend stores this as
   *  CostSaving.usdSaved (compression only — cache$ is NOT credited to Headroom). */
  compressionSavingsUsd: number;
  /** COMPRESSION RATE (0–100) — the proxy's `avg_compression_pct`. A RATE, not a
   *  cumulative counter, so it is carried through as the latest absolute value
   *  (never diffed). Drives the Home card's "avg compression" pill. */
  compressionPct: number;
}

/** Claude Sonnet input $/M — the default when the agent's price is unknown. */
const DEFAULT_INPUT_PRICE_PER_MILLION = 3;

/**
 * Timeout for the reporter's HTTP calls (the :8787 stats probe AND the
 * backend savings-ingest POST). Both used to be bare `fetch` with no signal,
 * so a wedged proxy or an unreachable ingest endpoint could park a reporter
 * tick forever. 10 s is generous for a localhost GET and a single small POST.
 */
export const HEADROOM_FETCH_TIMEOUT_MS = 10_000;

/**
 * `fetch` with an AbortController timeout — same pattern as pair-auto's
 * claim fetch and proxy-supervisor's `/livez` probe. Rethrows the AbortError
 * so callers keep their existing best-effort catch semantics.
 */
export async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs: number = HEADROOM_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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
      /** Headroom's headline "tokens saved" — compression + CLI filtering. */
      total_tokens_saved_with_cli_filtering?: number;
      /** Headroom's avg compression rate (0–100) over compressed requests. */
      avg_compression_pct?: number;
    };
    mcp?: {
      retrievals?: number;
    };
    cost?: {
      breakdown?: {
        cache_savings_usd?: number;
        /** The proxy's own compression $ (eliminated tokens at model list price). */
        compression_savings_usd?: number;
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
  /**
   * Top-level cost block (NOT under summary) — verified live on headroom v0.27.0
   * when the proxy is started with `--budget <USD> --budget-period <period>`.
   *
   * `cost_with_headroom_usd` is the actual amount paid by the user this period
   * (after Headroom savings are applied). `budget_limit_usd` and `budget_period`
   * are only present when the proxy was started with `--budget`.
   */
  cost?: {
    /** Actual spend this period (USD) — what the user was billed after savings. */
    cost_with_headroom_usd?: number;
    /** The configured per-period budget cap (USD). Only present when --budget used. */
    budget_limit_usd?: number;
    /** Budget reset cadence ("hourly"|"daily"|"monthly"). Only present with --budget. */
    budget_period?: string;
  };
}

/**
 * Budget context derived from /stats + configured env for a single reporter tick.
 * Forwarded as the second argument to `postSavings`; undefined when no budget is
 * configured (additive — callers that don't need it are unaffected).
 */
export interface BudgetContext {
  /** Spend so far this period (USD) — `cost.cost_with_headroom_usd` from /stats. */
  periodSpendUsd: number;
  /** The user-configured per-period budget cap (USD) — from HEADROOM_BUDGET env. */
  budgetUsd: number;
  /** Budget reset cadence — from HEADROOM_BUDGET_PERIOD env (default "daily"). */
  budgetPeriod: string;
  /** True iff this turn pushed periodSpendUsd to or past budgetUsd. */
  budgetReached?: boolean;
}

const ZERO: Savings = {
  rawTokensEst: 0,
  sentTokensEst: 0,
  cachedTokens: 0,
  retrieveHops: 0,
  cacheReadTokens: 0,
  cacheSavingsUsd: 0,
  compressionTokens: 0,
  compressionSavingsUsd: 0,
  compressionPct: 0,
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

  // COMPRESSION tokens saved — prefer the proxy's authoritative headline
  // (compression + CLI filtering), then tokens_removed, then (raw − sent).
  const compressionTokens =
    compression?.total_tokens_saved_with_cli_filtering ??
    compression?.total_tokens_removed ??
    Math.max(0, rawTokensEst - sentTokensEst);

  // COMPRESSION $ — prefer the proxy's own figure (eliminated tokens at the
  // model's LIST price, more accurate than our flat default); otherwise compute
  // from the compression tokens × the resolved input price. Cumulative (like
  // raw/sent) so mapStatsToSavings can diff it into a delta.
  const compressionSavingsUsd =
    stats.summary?.cost?.breakdown?.compression_savings_usd ??
    (Math.max(0, compressionTokens) / 1_000_000) * inputPricePerMillion;

  return {
    rawTokensEst,
    sentTokensEst,
    cachedTokens: 0,
    retrieveHops: stats.summary?.mcp?.retrievals ?? 0,
    cacheReadTokens: stats.prefix_cache?.totals?.cache_read_tokens ?? 0,
    cacheSavingsUsd: stats.summary?.cost?.breakdown?.cache_savings_usd ?? 0,
    compressionTokens,
    compressionSavingsUsd,
    compressionPct: compression?.avg_compression_pct ?? 0,
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
        compressionTokens: d(next.compressionTokens, prev.compressionTokens),
        compressionSavingsUsd: d(next.compressionSavingsUsd, prev.compressionSavingsUsd),
        // RATE — carry the latest absolute value through, never diff it.
        compressionPct: next.compressionPct,
      };
  return { next, delta };
}

export interface ReporterDeps {
  fetchStats: () => Promise<StatsShape>;            // GET localhost:8787/stats
  /** Called when savings advanced. `budget` is undefined when no budget is configured. */
  postSavings: (delta: Savings, budget?: BudgetContext) => Promise<void>;
  intervalMs?: number;                              // default from HEADROOM_STATS_POLL_INTERVAL_MS or 30_000
  /** Input $/M for the running agent's model — values the compressed-away
   *  tokens. Defaults to Claude Sonnet ($3/M) when the caller can't resolve it. */
  inputPricePerMillionUsd?: number;
  /**
   * Returns the configured budget from the environment, or `null` when no budget
   * is set. Defaults to reading `HEADROOM_BUDGET` / `HEADROOM_BUDGET_PERIOD` from
   * `process.env` — injectable for testing without mutating process.env.
   */
  getBudgetEnv?: () => { budgetUsd: number; budgetPeriod: string } | null;
}

/** Default getBudgetEnv: reads HEADROOM_BUDGET / HEADROOM_BUDGET_PERIOD from process.env. */
function defaultGetBudgetEnv(): { budgetUsd: number; budgetPeriod: string } | null {
  const raw = process.env['HEADROOM_BUDGET'];
  if (!raw) return null;
  const budgetUsd = Number(raw);
  if (!isFinite(budgetUsd) || budgetUsd <= 0) return null;
  const budgetPeriod = process.env['HEADROOM_BUDGET_PERIOD'] ?? 'daily';
  return { budgetUsd, budgetPeriod };
}

/**
 * Scoped LOCAL reporter. This polls a localhost sidecar (not the backend SSE
 * path) for optional observability — it is the documented-exception kind of
 * poll, not real-time command delivery. Interval is tunable; default 30s.
 */
export class HeadroomStatsReporter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private prev: Savings = ZERO;
  /** Period spend observed on the previous budgeted post — lets `budgetReached`
   *  fire once per crossing instead of on every post while over the cap. */
  private prevPeriodSpendUsd: number | null = null;
  constructor(private readonly deps: ReporterDeps) {}

  start(): void {
    const ms = this.deps.intervalMs
      ?? (Number(process.env.HEADROOM_STATS_POLL_INTERVAL_MS ?? '30000') || 30_000);
    this.timer = setInterval(() => void this.tick(), ms);
  }
  async tick(): Promise<void> {
    try {
      const stats = await this.deps.fetchStats();
      const { next, delta } = mapStatsToSavings(
        stats,
        this.prev,
        this.deps.inputPricePerMillionUsd ?? DEFAULT_INPUT_PRICE_PER_MILLION,
      );
      this.prev = next;
      // Report when ANY dimension advanced. The badge counts only compression
      // (compressionTokens / compressionSavingsUsd), but we still post when the
      // prompt-cache dimension moves so the observability columns
      // (cacheReadTokens) stay populated server-side.
      if (
        delta.compressionTokens > 0 ||
        delta.compressionSavingsUsd > 0 ||
        delta.rawTokensEst > 0 ||
        delta.cacheReadTokens > 0 ||
        delta.cacheSavingsUsd > 0
      ) {
        // Build optional budget context — additive: undefined when no budget set.
        const getBudgetEnv = this.deps.getBudgetEnv ?? defaultGetBudgetEnv;
        const budgetEnv = getBudgetEnv();
        let budget: BudgetContext | undefined;
        if (budgetEnv) {
          const periodSpendUsd = stats.cost?.cost_with_headroom_usd ?? 0;
          // budgetReached fires once per crossing: only when THIS post moved
          // the spend to/past the cap (previous observation was still below
          // it, or this is the first budgeted observation). A period reset
          // drops the spend below the cap, re-arming the flag naturally.
          const crossed =
            periodSpendUsd >= budgetEnv.budgetUsd &&
            (this.prevPeriodSpendUsd === null || this.prevPeriodSpendUsd < budgetEnv.budgetUsd);
          this.prevPeriodSpendUsd = periodSpendUsd;
          budget = {
            periodSpendUsd,
            budgetUsd: budgetEnv.budgetUsd,
            budgetPeriod: budgetEnv.budgetPeriod,
            ...(crossed ? { budgetReached: true } : {}),
          };
        }
        await this.deps.postSavings(delta, budget);
      }
    } catch {
      /* best-effort observability — never throw from the reporter */
    }
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}
