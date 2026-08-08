import { describe, it, expect } from 'vitest';
import {
  DEFAULT_GUARDRAIL_POLICY,
  GUARDRAIL_CATEGORIES,
  GUARDRAIL_CATEGORY_META,
  isGuardrailDisposition,
  normalizeGuardrailPolicy,
} from '../src/guardrails';

describe('guardrail policy model', () => {
  it('defaults every category to confirm (safe-by-default, default-on)', () => {
    for (const cat of GUARDRAIL_CATEGORIES) {
      expect(DEFAULT_GUARDRAIL_POLICY[cat]).toBe('confirm');
    }
  });

  it('has metadata for every category', () => {
    for (const cat of GUARDRAIL_CATEGORIES) {
      expect(GUARDRAIL_CATEGORY_META[cat].label.length).toBeGreaterThan(0);
      expect(GUARDRAIL_CATEGORY_META[cat].description.length).toBeGreaterThan(0);
    }
  });

  it('isGuardrailDisposition accepts only the three values', () => {
    expect(isGuardrailDisposition('deny')).toBe(true);
    expect(isGuardrailDisposition('confirm')).toBe(true);
    expect(isGuardrailDisposition('off')).toBe(true);
    expect(isGuardrailDisposition('nope')).toBe(false);
    expect(isGuardrailDisposition(undefined)).toBe(false);
  });

  describe('normalizeGuardrailPolicy', () => {
    it('absent / garbage → the full default policy', () => {
      expect(normalizeGuardrailPolicy(undefined)).toEqual(DEFAULT_GUARDRAIL_POLICY);
      expect(normalizeGuardrailPolicy(null)).toEqual(DEFAULT_GUARDRAIL_POLICY);
      expect(normalizeGuardrailPolicy('x')).toEqual(DEFAULT_GUARDRAIL_POLICY);
    });

    it('fills missing categories from the default and keeps valid overrides', () => {
      const p = normalizeGuardrailPolicy({ secretRead: 'deny', destructiveShell: 'off' });
      expect(p.secretRead).toBe('deny');
      expect(p.destructiveShell).toBe('off');
      expect(p.protectedBranch).toBe('confirm');
      expect(p.outwardIrreversible).toBe('confirm');
    });

    it('rejects an invalid disposition value back to the default', () => {
      const p = normalizeGuardrailPolicy({ secretRead: 'YOLO' });
      expect(p.secretRead).toBe('confirm');
    });
  });
});
