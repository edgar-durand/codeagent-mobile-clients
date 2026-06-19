// __tests__/headroom/stats-reporter.test.ts
import { it, expect, describe } from 'vitest';
import { mapStatsToSavings } from '../../src/services/headroom/stats-reporter';

// Real /stats response captured from headroom-ai 0.26.0
const REAL_STATS = {
  summary: {
    mode: 'token',
    api_requests: 17,
    primary_model: 'claude-opus-4-8',
    compression: {
      requests_compressed: 8,
      avg_compression_pct: 0.8,
      total_tokens_removed: 998,
      total_tokens_saved_with_cli_filtering: 998,
      total_tokens_before_with_cli_filtering: 211215,
      total_tokens_saved_with_rtk: 998,
      total_tokens_before_with_rtk: 211215,
    },
    mcp: { compressions: 0, tokens_removed: 0, retrievals: 0 },
  },
  agent_usage: {
    agents: [
      {
        agent: 'claude-code',
        label: 'Claude',
        requests: 17,
        before_tokens: 211215,
        after_tokens: 210217,
        output_tokens: 17905,
        tokens_saved: 998,
      },
    ],
    totals: {
      requests: 17,
      before_tokens: 211215,
      after_tokens: 210217,
      output_tokens: 17905,
      tokens_saved: 998,
    },
  },
};

const ZERO = { rawTokensEst: 0, sentTokensEst: 0, cachedTokens: 0, retrieveHops: 0 };

describe('read() — parses the real /stats shape', () => {
  it('extracts rawTokensEst and sentTokensEst from agent_usage.totals', () => {
    const { next } = mapStatsToSavings(REAL_STATS, ZERO);
    expect(next.rawTokensEst).toBe(211215);
    expect(next.sentTokensEst).toBe(210217);
    expect(next.retrieveHops).toBe(0);
  });

  it('sets cachedTokens to 0 (no such field in /stats)', () => {
    const { next } = mapStatsToSavings(REAL_STATS, ZERO);
    expect(next.cachedTokens).toBe(0);
  });
});

describe('mapStatsToSavings — delta logic', () => {
  it('first call with prev=ZERO → delta equals next (would trigger a POST)', () => {
    const { delta } = mapStatsToSavings(REAL_STATS, ZERO);
    expect(delta.rawTokensEst).toBe(211215);
    expect(delta.sentTokensEst).toBe(210217);
  });

  it('second call with identical stats → delta is all-zero (no double-count)', () => {
    const { next } = mapStatsToSavings(REAL_STATS, ZERO);
    const { delta } = mapStatsToSavings(REAL_STATS, next);
    expect(delta).toEqual(ZERO);
  });

  it('counter reset (next < prev) → reports next reading as the delta', () => {
    const prev = { rawTokensEst: 211215, sentTokensEst: 210217, cachedTokens: 0, retrieveHops: 0 };
    // Proxy restarted — counters back to a small number
    const resetStats = {
      summary: { compression: { total_tokens_before_with_cli_filtering: 0, total_tokens_removed: 0 }, mcp: { retrievals: 0 } },
      agent_usage: { totals: { before_tokens: 100, after_tokens: 90 } },
    };
    const { delta } = mapStatsToSavings(resetStats, prev);
    expect(delta.rawTokensEst).toBe(100);
    expect(delta.sentTokensEst).toBe(90);
  });
});

describe('read() — tolerance for missing / partial data', () => {
  it('empty object → all zeros, no throw', () => {
    const { next, delta } = mapStatsToSavings({}, ZERO);
    expect(next).toEqual(ZERO);
    expect(delta).toEqual(ZERO);
  });

  it('only summary.compression present (no agent_usage) → falls back to compression fields', () => {
    const stats = {
      summary: {
        compression: {
          total_tokens_before_with_cli_filtering: 50000,
          total_tokens_removed: 2000,
        },
        mcp: { retrievals: 3 },
      },
    };
    const { next } = mapStatsToSavings(stats, ZERO);
    expect(next.rawTokensEst).toBe(50000);
    expect(next.sentTokensEst).toBe(48000); // 50000 - 2000
    expect(next.retrieveHops).toBe(3);
  });

  it('agent_usage.totals takes priority over summary.compression', () => {
    const stats = {
      summary: {
        compression: {
          total_tokens_before_with_cli_filtering: 99999,
          total_tokens_removed: 999,
        },
        mcp: { retrievals: 0 },
      },
      agent_usage: {
        totals: { before_tokens: 211215, after_tokens: 210217 },
      },
    };
    const { next } = mapStatsToSavings(stats, ZERO);
    expect(next.rawTokensEst).toBe(211215);
    expect(next.sentTokensEst).toBe(210217);
  });
});
