import { describe, test, expect } from 'vitest';
import { computePollDelay } from '../../src/lib/poll-delay';

describe('computePollDelay', () => {
  test('zero failures: base ms ±10% jitter, no exp scaling', () => {
    for (let i = 0; i < 200; i++) {
      const d = computePollDelay({ baseMs: 2000, failures: 0 });
      expect(d).toBeGreaterThanOrEqual(1800);
      expect(d).toBeLessThanOrEqual(2200);
    }
  });

  test('one failure doubles base before jitter', () => {
    for (let i = 0; i < 200; i++) {
      const d = computePollDelay({ baseMs: 2000, failures: 1 });
      expect(d).toBeGreaterThanOrEqual(3600);
      expect(d).toBeLessThanOrEqual(4400);
    }
  });

  test('caps exp scaling at 30 seconds (±10% jitter)', () => {
    for (let i = 0; i < 200; i++) {
      const d = computePollDelay({ baseMs: 2000, failures: 10 });
      expect(d).toBeGreaterThanOrEqual(27000);
      expect(d).toBeLessThanOrEqual(33000);
    }
  });

  test('returns an integer', () => {
    expect(Number.isInteger(computePollDelay({ baseMs: 2000, failures: 0 }))).toBe(true);
  });
});
