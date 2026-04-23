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

  it('exposes positive numbers for every pricing field', () => {
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
    expect(getContextWindow('gpt-5')).toBe(200_000);
  });

  it('MODEL_CONTEXT_WINDOW covers every MODEL_PRICING entry', () => {
    for (const model of Object.keys(MODEL_PRICING)) {
      expect(MODEL_CONTEXT_WINDOW[model], `missing window for ${model}`).toBeDefined();
    }
  });
});
