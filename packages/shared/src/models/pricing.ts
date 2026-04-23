export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.50, cacheWrite: 18.75 },
  'claude-3-5-sonnet': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-3-5-haiku': { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  'claude-3-haiku': { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.30 },
};

export const MODEL_CONTEXT_WINDOW: Record<string, number> = {
  'claude-opus-4': 1_000_000,
  'claude-sonnet-4': 1_000_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-haiku': 200_000,
  'claude-3-haiku': 200_000,
};

const DEFAULT_CONTEXT_WINDOW = 200_000;

export function getPricing(model: string): ModelPricing {
  for (const [prefix, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(prefix)) return pricing;
  }
  return MODEL_PRICING['claude-sonnet-4'];
}

export function getContextWindow(model: string | null): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  for (const [prefix, size] of Object.entries(MODEL_CONTEXT_WINDOW)) {
    if (model.startsWith(prefix)) return size;
  }
  return DEFAULT_CONTEXT_WINDOW;
}
