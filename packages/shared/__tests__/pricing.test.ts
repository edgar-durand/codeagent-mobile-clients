import { describe, it, expect } from 'vitest';
import {
  getContextWindow,
  getPricing,
  MODEL_CONTEXT_WINDOW,
  MODEL_PRICING,
} from '../src';

describe('getPricing', () => {
  it('returns the exact entry for a known model family', () => {
    expect(getPricing('claude-opus-4-20250514')).toEqual(MODEL_PRICING['claude-opus-4']);
    expect(getPricing('claude-sonnet-4-20250514')).toEqual(MODEL_PRICING['claude-sonnet-4']);
    expect(getPricing('claude-3-5-haiku-20241022')).toEqual(MODEL_PRICING['claude-3-5-haiku']);
  });

  it('matches by prefix, not full ID', () => {
    expect(getPricing('claude-3-5-sonnet-any-suffix')).toEqual(MODEL_PRICING['claude-3-5-sonnet']);
  });

  it('falls back to claude-sonnet-4 pricing for unknown models', () => {
    expect(getPricing('claude-future-model-v9')).toEqual(MODEL_PRICING['claude-sonnet-4']);
    expect(getPricing('unknown')).toEqual(MODEL_PRICING['claude-sonnet-4']);
  });

  it('exposes positive numbers for every non-placeholder pricing field', () => {
    for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
      // Codex/OpenAI entries are Phase 2 placeholders (all zeros until OpenAI
      // publishes confirmed rates). Skip the assertion for those.
      const isPlaceholder = pricing.input === 0 && pricing.output === 0;
      if (isPlaceholder) continue;
      expect(pricing.input, `${model}.input`).toBeGreaterThan(0);
      expect(pricing.output, `${model}.output`).toBeGreaterThan(0);
      expect(pricing.cacheRead, `${model}.cacheRead`).toBeGreaterThan(0);
      expect(pricing.cacheWrite, `${model}.cacheWrite`).toBeGreaterThan(0);
    }
  });

  it('Codex placeholder entries are present with zero pricing', () => {
    const codexModels = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2', 'codex-auto-review'];
    for (const model of codexModels) {
      expect(MODEL_PRICING[model], `missing entry for ${model}`).toBeDefined();
      expect(MODEL_PRICING[model].input, `${model}.input`).toBe(0);
      expect(MODEL_PRICING[model].output, `${model}.output`).toBe(0);
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
