export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // ── Anthropic / Claude ────────────────────────────────────
  // The 4.x rows below cover the model ids actually emitted by the CLI
  // (apps/cli/src/agents/claude/runtime.ts listModels) and the JetBrains
  // fallback catalog (RemoteCommandRouter.kt). Prices are copied from the
  // same-family base rows (claude-opus-4 / claude-sonnet-4 /
  // claude-3-5-haiku) until distinct published rates land.
  'claude-opus-4-7': { input: 15, output: 75, cacheRead: 1.50, cacheWrite: 18.75 },
  'claude-opus-4-6': { input: 15, output: 75, cacheRead: 1.50, cacheWrite: 18.75 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  // Haiku-tier prices copied from claude-3-5-haiku (closest same-tier
  // sibling in this table) — previously this id matched NO row and was
  // silently billed at sonnet rates via the unknown-model fallback.
  'claude-haiku-4-5': { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.50, cacheWrite: 18.75 },
  'claude-3-5-sonnet': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-3-5-haiku': { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  'claude-3-haiku': { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.30 },

  // ── Codex / OpenAI ────────────────────────────────────────
  // GPT-5.x rows are derived from OpenAI's published GPT-5 family rates
  // (standard tier: $1.25/1M in, $10/1M out, cached input at ~10% of input;
  // mini tier: $0.25/1M in, $2/1M out). OpenAI has no separate cache-WRITE
  // premium, so cacheWrite mirrors the input rate. Replace with the exact
  // per-version numbers from developers.openai.com/pricing when published —
  // these were the ZERO placeholders that rendered Codex sessions as $0.
  'gpt-5.5': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5.4': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5.4-mini': { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 },
  'gpt-5.3-codex': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5.2': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'codex-auto-review': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
};

export const MODEL_CONTEXT_WINDOW: Record<string, number> = {
  // ── Anthropic / Claude ────────────────────────────────────
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-haiku-4-5': 200_000,
  'claude-opus-4': 1_000_000,
  'claude-sonnet-4': 1_000_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-haiku': 200_000,
  'claude-3-haiku': 200_000,

  // ── Codex / OpenAI ────────────────────────────────────────
  'gpt-5.5': 272_000,
  'gpt-5.4': 272_000,
  'gpt-5.4-mini': 272_000,
  'gpt-5.3-codex': 272_000,
  'gpt-5.2': 272_000,
  'codex-auto-review': 272_000,
};

const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Longest-prefix lookup. The tables key by model-family prefix; a model id
 * like `claude-opus-4-7` must resolve to its own row, not be shadowed by the
 * shorter `claude-opus-4` — so the match is by prefix LENGTH, never by the
 * table's insertion order.
 */
function longestPrefixMatch<T>(table: Record<string, T>, model: string): T | undefined {
  let best: T | undefined;
  let bestLen = -1;
  for (const [prefix, value] of Object.entries(table)) {
    if (prefix.length > bestLen && model.startsWith(prefix)) {
      best = value;
      bestLen = prefix.length;
    }
  }
  return best;
}

/** True when the model id resolves to a real MODEL_PRICING row (i.e. getPricing
 *  will NOT be guessing via the unknown-model fallback). */
export function isKnownModel(model: string): boolean {
  return longestPrefixMatch(MODEL_PRICING, model) !== undefined;
}

/**
 * Flagged default for an unpriced model id. All-zero so an unknown model is
 * VISIBLY unpriced ($0) rather than silently MISPRICED at some other family's
 * rates (the old sonnet-4 fallback billed unknown ids — including a haiku id
 * that matched no row — at sonnet rates). `getPricing` returns this object for
 * unknown ids so callers that do unconditional arithmetic still work; callers
 * that must distinguish real pricing from the default check `isKnownModel`.
 */
export const UNKNOWN_MODEL_PRICING: ModelPricing = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Resolve pricing by longest matching prefix. Unknown models resolve to the
 * flagged {@link UNKNOWN_MODEL_PRICING} default (all-zero, i.e. visibly
 * unpriced) instead of guessing at another model's rates. Callers that need to
 * distinguish real pricing from the default must check `isKnownModel(model)`.
 */
export function getPricing(model: string): ModelPricing {
  return longestPrefixMatch(MODEL_PRICING, model) ?? UNKNOWN_MODEL_PRICING;
}

export function getContextWindow(model: string | null): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  return longestPrefixMatch(MODEL_CONTEXT_WINDOW, model) ?? DEFAULT_CONTEXT_WINDOW;
}
