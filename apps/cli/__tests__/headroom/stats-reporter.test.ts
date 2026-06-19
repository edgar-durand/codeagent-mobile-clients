// __tests__/headroom/stats-reporter.test.ts
import { it, expect } from 'vitest';
import { mapStatsToSavings } from '../../src/services/headroom/stats-reporter';

it('emits the DELTA since the previous reading (counters are cumulative)', () => {
  const prev = { rawTokensEst: 1000, sentTokensEst: 300, cachedTokens: 100, retrieveHops: 2 };
  const stats = { persistent_savings: { tokens_before: 1500, tokens_after: 400, cached_tokens: 150, retrieve_hops: 3 } };
  expect(mapStatsToSavings(stats, prev)).toEqual({
    next: { rawTokensEst: 1500, sentTokensEst: 400, cachedTokens: 150, retrieveHops: 3 },
    delta: { rawTokensEst: 500, sentTokensEst: 100, cachedTokens: 50, retrieveHops: 1 },
  });
});
it('treats a missing persistent_savings block as a zero reading (no throw)', () => {
  const out = mapStatsToSavings({}, { rawTokensEst: 0, sentTokensEst: 0, cachedTokens: 0, retrieveHops: 0 });
  expect(out.delta).toEqual({ rawTokensEst: 0, sentTokensEst: 0, cachedTokens: 0, retrieveHops: 0 });
});
it('clamps negative deltas to 0 (proxy restart resets counters)', () => {
  const prev = { rawTokensEst: 1000, sentTokensEst: 300, cachedTokens: 100, retrieveHops: 5 };
  const stats = { persistent_savings: { tokens_before: 50, tokens_after: 10, cached_tokens: 5, retrieve_hops: 0 } };
  expect(mapStatsToSavings(stats, prev).delta).toEqual({ rawTokensEst: 50, sentTokensEst: 10, cachedTokens: 5, retrieveHops: 0 });
});
