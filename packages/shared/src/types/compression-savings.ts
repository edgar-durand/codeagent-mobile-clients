/**
 * Wire types for GET /api/admin/compression-savings (admin Token Savings tab).
 * Owned here since 2026-10-09 (epic codeagent-pi6).
 */

/**
 * Per-agent monthly savings row (or the aggregate 'all' row).
 * All token fields are raw counters. Derived ratios are computed
 * server-side from the SUMMED counters (not by averaging per-agent
 * ratios) so the totals row is arithmetically consistent.
 */
export interface AgentSavings {
  agentId: string;
  rawTokensEst: number;
  sentTokensEst: number;
  cachedTokens: number;
  retrieveHops: number;
  turns: number;
  /** rawTokensEst - sentTokensEst */
  tokensSaved: number;
  /** rawTokensEst > 0 ? (raw - sent) / raw : 0  (0..1) */
  reductionPct: number;
  /** sentTokensEst > 0 ? cachedTokens / sentTokensEst : 0  (0..1) */
  cacheHitPct: number;
  /** Dollars saved vs. sending the full uncompressed request uncached.
   *  Formula: baselineCost - actualCost, where
   *    baselineCost = rawTokensEst * INPUT_RATE
   *    actualCost   = (sentTokensEst - cachedTokens) * INPUT_RATE + cachedTokens * CACHED_RATE
   *  Rates: INPUT_RATE = 0.60 / 1_000_000, CACHED_RATE = 0.12 / 1_000_000 */
  dollarsSaved: number;
  /** PROMPT-CACHE dimension — distinct from `cachedTokens` above (which feeds
   *  the compression dollar formula). For BYO agents (Claude Code etc.) the
   *  dominant saving is provider prefix-caching, NOT token compression: the
   *  proxy serves a large repeated prefix from cache at ~10% of input price.
   *  `cacheReadTokens` is the cumulative cache-read token count (can exceed
   *  sentTokensEst — the prefix is re-read every turn), so it is kept separate
   *  from the compression math. */
  cacheReadTokens: number;
  /** Cost saved by prompt-caching, taken verbatim from the proxy's own
   *  `/stats` (`summary.cost.breakdown.cache_savings_usd`), computed at the
   *  real model price — NOT recomputed here, so it stays correct as model
   *  pricing changes. Counterfactual list-price dollars for subscription
   *  agents; the real value is usage-headroom within rate limits. */
  cacheSavingsUsd: number;
}

/** One day's aggregated compression savings (summed across all agents). */
export interface CompressionSavingsDaily {
  date: string;            // YYYY-MM-DD
  rawTokensEst: number;
  sentTokensEst: number;
  cachedTokens: number;
  tokensSaved: number;
  dollarsSaved: number;
  /** Prompt-cache dimension (see AgentSavings.cacheReadTokens/cacheSavingsUsd). */
  cacheReadTokens: number;
  cacheSavingsUsd: number;
}

/** Response body for GET /api/admin/compression-savings?month=YYYY-MM */
export interface CompressionSavingsData {
  /** YYYY-MM echoed back from the query parameter. */
  month: string;
  /** Rate constants used to compute dollarsSaved (for UI transparency). */
  rates: { inputPerMtok: number; cachedPerMtok: number };
  /** Element-wise sum across all agents; agentId = 'all'. */
  totals: AgentSavings;
  /** One entry per enumerated agent (from the agent registry). */
  perAgent: AgentSavings[];
  /** One entry per calendar day ascending, incl. zero days, up to today
   *  for the current month or through the last day for a past month. */
  dailyTrend: CompressionSavingsDaily[];
}
