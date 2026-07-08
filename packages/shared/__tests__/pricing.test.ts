import { describe, it, expect } from 'vitest';
import {
  getContextWindow,
  getPricing,
  isKnownModel,
  MODEL_CONTEXT_WINDOW,
  MODEL_PRICING,
  UNKNOWN_MODEL_PRICING,
} from '../src';

// Model ids actually emitted by the shipped catalogs. Keep in sync with:
// - apps/cli/src/agents/claude/runtime.ts (listModels)
// - apps/jetbrains-plugin/.../ui/RemoteCommandRouter.kt (CLI fallback catalog)
const SHIPPED_CLAUDE_MODEL_IDS = [
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
];

// Codex catalog. Keep in sync with apps/cli/src/agents/codex/runtime.ts
// (CODEX_MODELS / listModels). `codex-auto-review` is the internal review model.
const SHIPPED_CODEX_MODEL_IDS = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.2',
  'codex-auto-review',
];

const SHIPPED_MODEL_IDS = [...SHIPPED_CLAUDE_MODEL_IDS, ...SHIPPED_CODEX_MODEL_IDS];

describe('getPricing', () => {
  it('returns the exact entry for a known model family', () => {
    expect(getPricing('claude-opus-4-20250514')).toEqual(MODEL_PRICING['claude-opus-4']);
    expect(getPricing('claude-sonnet-4-20250514')).toEqual(MODEL_PRICING['claude-sonnet-4']);
    expect(getPricing('claude-3-5-haiku-20241022')).toEqual(MODEL_PRICING['claude-3-5-haiku']);
  });

  it('matches by prefix, not full ID', () => {
    expect(getPricing('claude-3-5-sonnet-any-suffix')).toEqual(MODEL_PRICING['claude-3-5-sonnet']);
  });

  it('longest prefix wins regardless of table insertion order', () => {
    // 'claude-opus-4-7' must hit its own row, not the shorter 'claude-opus-4'.
    // toBe (reference equality) so identical price values can't mask a
    // wrong-row match.
    expect(getPricing('claude-opus-4-7')).toBe(MODEL_PRICING['claude-opus-4-7']);
    expect(getPricing('claude-opus-4-20250514')).toBe(MODEL_PRICING['claude-opus-4']);
    // 'gpt-5.4' is inserted BEFORE 'gpt-5.4-mini' — insertion-order matching
    // would shadow the mini row.
    expect(getPricing('gpt-5.4-mini-2026-01')).toBe(MODEL_PRICING['gpt-5.4-mini']);
  });

  it('every shipped catalog model id resolves to a real, non-zero priced row (never the fallback)', () => {
    for (const id of SHIPPED_MODEL_IDS) {
      expect(isKnownModel(id), `${id} hit the unknown-model fallback`).toBe(true);
      const pricing = getPricing(id);
      expect(pricing, `${id} resolved to the flagged unknown-model default`).not.toBe(
        UNKNOWN_MODEL_PRICING,
      );
      // A priced row must charge for the two billed dimensions — a $0 row
      // renders the session as free (the Codex $0 bug + the haiku-at-sonnet
      // mispricing this table guards against).
      expect(pricing.input, `${id}.input`).toBeGreaterThan(0);
      expect(pricing.output, `${id}.output`).toBeGreaterThan(0);
    }
    // The dated haiku id previously matched NO row and was silently billed at
    // sonnet rates via the fallback — it must resolve to the haiku-tier row.
    expect(getPricing('claude-haiku-4-5-20251001')).toBe(MODEL_PRICING['claude-haiku-4-5']);
    expect(getPricing('claude-opus-4-6')).toBe(MODEL_PRICING['claude-opus-4-6']);
    expect(getPricing('claude-sonnet-4-6')).toBe(MODEL_PRICING['claude-sonnet-4-6']);
  });

  it('resolves unknown models to the flagged (all-zero) default, not a mispriced guess', () => {
    // Regression: the old fallback returned claude-sonnet-4 rates, silently
    // MISPRICING unknown ids. The flagged default is visibly $0 instead, and
    // isKnownModel exposes that it is unpriced.
    expect(getPricing('claude-future-model-v9')).toBe(UNKNOWN_MODEL_PRICING);
    expect(getPricing('unknown')).toBe(UNKNOWN_MODEL_PRICING);
    expect(getPricing('unknown')).not.toBe(MODEL_PRICING['claude-sonnet-4']);
    expect(UNKNOWN_MODEL_PRICING).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(isKnownModel('claude-future-model-v9')).toBe(false);
    expect(isKnownModel('unknown')).toBe(false);
    expect(isKnownModel('claude-sonnet-4-20250514')).toBe(true);
  });

  it('every priced row exposes positive numbers for every field', () => {
    for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
      expect(pricing.input, `${model}.input`).toBeGreaterThan(0);
      expect(pricing.output, `${model}.output`).toBeGreaterThan(0);
      expect(pricing.cacheRead, `${model}.cacheRead`).toBeGreaterThan(0);
      expect(pricing.cacheWrite, `${model}.cacheWrite`).toBeGreaterThan(0);
    }
  });
});

describe('getContextWindow', () => {
  it('returns 1M for opus-4 and sonnet-4', () => {
    expect(getContextWindow('claude-opus-4-20250514')).toBe(1_000_000);
    expect(getContextWindow('claude-sonnet-4-20250514')).toBe(1_000_000);
  });

  it('returns 200k for the 3.5 family', () => {
    expect(getContextWindow('claude-3-5-sonnet-20241022')).toBe(200_000);
    expect(getContextWindow('claude-3-5-haiku-20241022')).toBe(200_000);
  });

  it('returns 200k for null input (unknown model default)', () => {
    expect(getContextWindow(null)).toBe(200_000);
  });

  it('falls back to 200k for unknown models', () => {
    expect(getContextWindow('claude-future-model-v9')).toBe(200_000);
    // 'gpt-5' does not start with any registered Codex prefix (e.g. 'gpt-5.5'),
    // so it falls through to the 200k default.
    expect(getContextWindow('gpt-5')).toBe(200_000);
  });

  it('returns 272k for Codex/OpenAI models', () => {
    expect(getContextWindow('gpt-5.5')).toBe(272_000);
    expect(getContextWindow('gpt-5.4-mini')).toBe(272_000);
    expect(getContextWindow('gpt-5.3-codex')).toBe(272_000);
    expect(getContextWindow('codex-auto-review')).toBe(272_000);
  });

  it('MODEL_CONTEXT_WINDOW covers every MODEL_PRICING entry', () => {
    for (const model of Object.keys(MODEL_PRICING)) {
      expect(MODEL_CONTEXT_WINDOW[model], `missing window for ${model}`).toBeDefined();
    }
  });
});
