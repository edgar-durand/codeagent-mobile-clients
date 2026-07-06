// __tests__/headroom/stats-reporter.budget.test.ts
//
// TDD for Task 10: stats-reporter surfaces period spend / budget (additive).
//
// Live /stats probe (headroom v0.27.0, started with --budget 10 --budget-period daily):
//   curl -s localhost:8799/stats | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d['cost']))"
//
// The budget-related fields live in the TOP-LEVEL `cost` block (NOT under `summary`):
//   cost.cost_with_headroom_usd  → period spend (what the user actually paid this period)
//   cost.budget_limit_usd        → the configured budget cap
//   cost.budget_period           → "hourly" | "daily" | "monthly"
//
// When `--budget` is NOT passed to the proxy, `budget_limit_usd` and `budget_period`
// are absent from the response. `cost_with_headroom_usd` is always present (0.0 when
// no traffic has flowed yet).
//
// Implementation:
//   - `StatsShape.cost` gains optional `cost_with_headroom_usd`, `budget_limit_usd`,
//     `budget_period` fields.
//   - `ReporterDeps` gains optional `getBudgetEnv()` (defaults to reading
//     process.env.HEADROOM_BUDGET / HEADROOM_BUDGET_PERIOD so the caller can inject
//     a fake for tests without mutating process.env).
//   - `postSavings` receives the delta PLUS the optional budget fields; the type of
//     the callback is updated to `(delta: Savings, budget?: BudgetContext) => Promise<void>`.
//   - When `HEADROOM_BUDGET` is NOT set → `budget` arg is `undefined` → callers omit
//     the new fields from the POST body (additive, zero behaviour change).

import { describe, it, expect } from 'vitest';
import {
  HeadroomStatsReporter,
  mapStatsToSavings,
  type StatsShape,
  type BudgetContext,
} from '../../src/services/headroom/stats-reporter';

// ---------------------------------------------------------------------------
// Fake /stats payload that mirrors the real shape observed live on 2026-06-28
// with --budget 10 --budget-period daily. The `cost` block is the key addition.
// ---------------------------------------------------------------------------
const STATS_WITH_BUDGET: StatsShape = {
  summary: {
    compression: {
      avg_compression_pct: 0.8,
      total_tokens_removed: 998,
      total_tokens_saved_with_cli_filtering: 998,
      total_tokens_before_with_cli_filtering: 211215,
    },
    mcp: { retrievals: 0 },
    cost: {
      breakdown: {
        cache_savings_usd: 11.69,
        compression_savings_usd: 0,
      },
    },
  },
  agent_usage: {
    totals: {
      before_tokens: 211215,
      after_tokens: 210217,
    },
  },
  prefix_cache: {
    totals: { cache_read_tokens: 2596682 },
  },
  // TOP-LEVEL cost block — present when --budget was passed to the proxy.
  cost: {
    cost_with_headroom_usd: 3.75,
    budget_limit_usd: 10.0,
    budget_period: 'daily',
  },
};

const STATS_NO_BUDGET: StatsShape = {
  summary: {
    compression: {
      total_tokens_saved_with_cli_filtering: 998,
      total_tokens_before_with_cli_filtering: 211215,
    },
    mcp: { retrievals: 0 },
    cost: {
      breakdown: {
        cache_savings_usd: 11.69,
        compression_savings_usd: 0,
      },
    },
  },
  agent_usage: {
    totals: { before_tokens: 211215, after_tokens: 210217 },
  },
  // cost block present but budget fields absent (no --budget flag on proxy)
  cost: {
    cost_with_headroom_usd: 1.23,
  },
};

const ZERO_SAVINGS = {
  rawTokensEst: 0,
  sentTokensEst: 0,
  cachedTokens: 0,
  retrieveHops: 0,
  cacheReadTokens: 0,
  cacheSavingsUsd: 0,
  compressionTokens: 0,
  compressionSavingsUsd: 0,
  compressionPct: 0,
};

// ---------------------------------------------------------------------------
// Tests: StatsShape — top-level cost block
// ---------------------------------------------------------------------------

describe('StatsShape — top-level cost block', () => {
  it('mapStatsToSavings does not throw when cost block is present', () => {
    expect(() => mapStatsToSavings(STATS_WITH_BUDGET, ZERO_SAVINGS)).not.toThrow();
  });

  it('mapStatsToSavings does not throw when cost block is absent', () => {
    expect(() => mapStatsToSavings({}, ZERO_SAVINGS)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: HeadroomStatsReporter — budget env → postSavings receives BudgetContext
// ---------------------------------------------------------------------------

describe('HeadroomStatsReporter.tick() — budget context forwarding', () => {
  it('passes BudgetContext to postSavings when HEADROOM_BUDGET env is set', async () => {
    const capturedBudget: BudgetContext[] = [];
    const reporter = new HeadroomStatsReporter({
      fetchStats: async () => STATS_WITH_BUDGET,
      postSavings: async (_delta, budget) => {
        if (budget) capturedBudget.push(budget);
      },
      intervalMs: 999_999,
      getBudgetEnv: () => ({ budgetUsd: 10, budgetPeriod: 'daily' }),
    });

    await reporter.tick();

    expect(capturedBudget).toHaveLength(1);
    expect(capturedBudget[0]).toEqual({
      periodSpendUsd: 3.75,     // cost.cost_with_headroom_usd
      budgetUsd: 10,             // HEADROOM_BUDGET env (10)
      budgetPeriod: 'daily',     // HEADROOM_BUDGET_PERIOD env ('daily')
    });
  });

  it('omits BudgetContext entirely when no budget env is configured', async () => {
    let capturedArgs: unknown[] = [];
    let callCount = 0;
    const reporter = new HeadroomStatsReporter({
      fetchStats: async () => STATS_NO_BUDGET,
      postSavings: async (...args) => {
        capturedArgs = args;
        callCount++;
      },
      intervalMs: 999_999,
      getBudgetEnv: () => null, // ← no budget configured
    });

    await reporter.tick();

    // postSavings was called (savings moved), and the second arg must be undefined
    expect(callCount).toBe(1);
    const budgetArg = capturedArgs[1];
    expect(budgetArg).toBeUndefined();
  });

  it('includes cost_with_headroom_usd from /stats as periodSpendUsd', async () => {
    let captured: BudgetContext | undefined;
    const reporter = new HeadroomStatsReporter({
      fetchStats: async () => ({
        ...STATS_WITH_BUDGET,
        cost: { cost_with_headroom_usd: 7.42, budget_limit_usd: 10.0, budget_period: 'daily' },
      }),
      postSavings: async (_delta, budget) => { captured = budget; },
      intervalMs: 999_999,
      getBudgetEnv: () => ({ budgetUsd: 10, budgetPeriod: 'daily' }),
    });

    await reporter.tick();

    expect(captured?.periodSpendUsd).toBe(7.42);
  });

  it('falls back to 0 for periodSpendUsd when cost block is absent from /stats', async () => {
    let captured: BudgetContext | undefined;
    const reporter = new HeadroomStatsReporter({
      fetchStats: async () => ({
        // no cost block at all
        agent_usage: { totals: { before_tokens: 100, after_tokens: 90 } },
      }),
      postSavings: async (_delta, budget) => { captured = budget; },
      intervalMs: 999_999,
      getBudgetEnv: () => ({ budgetUsd: 10, budgetPeriod: 'daily' }),
    });

    await reporter.tick();

    expect(captured?.periodSpendUsd).toBe(0);
  });

  it('reads budget env from process.env when getBudgetEnv is not provided', async () => {
    // This test validates the default getBudgetEnv() reads from process.env.
    // We set the env vars, construct without getBudgetEnv, and verify postSavings
    // receives a BudgetContext.
    const origBudget = process.env['HEADROOM_BUDGET'];
    const origPeriod = process.env['HEADROOM_BUDGET_PERIOD'];
    process.env['HEADROOM_BUDGET'] = '5';
    process.env['HEADROOM_BUDGET_PERIOD'] = 'monthly';
    const capturedBudgets: Array<BudgetContext | undefined> = [];
    try {
      const reporter = new HeadroomStatsReporter({
        fetchStats: async () => STATS_WITH_BUDGET,
        postSavings: async (_delta, budget) => { capturedBudgets.push(budget); },
        intervalMs: 999_999,
        // No getBudgetEnv → default impl reads process.env
      });
      await reporter.tick();
    } finally {
      if (origBudget === undefined) delete process.env['HEADROOM_BUDGET'];
      else process.env['HEADROOM_BUDGET'] = origBudget;
      if (origPeriod === undefined) delete process.env['HEADROOM_BUDGET_PERIOD'];
      else process.env['HEADROOM_BUDGET_PERIOD'] = origPeriod;
    }

    expect(capturedBudgets).toHaveLength(1);
    expect(capturedBudgets[0]).toMatchObject({ budgetUsd: 5, budgetPeriod: 'monthly' });
  });

  it('does not call postSavings when no savings delta occurred (existing gate unchanged)', async () => {
    // Fill up prev so the next identical stats produce zero delta
    let callCount = 0;
    const reporter = new HeadroomStatsReporter({
      fetchStats: async () => STATS_WITH_BUDGET,
      postSavings: async () => { callCount++; },
      intervalMs: 999_999,
      getBudgetEnv: () => ({ budgetUsd: 10, budgetPeriod: 'daily' }),
    });
    // First tick: delta > 0 → POST called
    await reporter.tick();
    expect(callCount).toBe(1);
    // Second tick: delta = 0 → POST NOT called
    await reporter.tick();
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: HeadroomStatsReporter — budgetReached crossing semantics
// ---------------------------------------------------------------------------

describe('HeadroomStatsReporter.tick() — budgetReached crossing', () => {
  /** Stats snapshot at a given cumulative token count + period spend. */
  const statsAt = (beforeTokens: number, spendUsd: number): StatsShape => ({
    agent_usage: { totals: { before_tokens: beforeTokens, after_tokens: beforeTokens - 100 } },
    cost: { cost_with_headroom_usd: spendUsd, budget_limit_usd: 10, budget_period: 'daily' },
  });

  const makeReporter = (getStats: () => StatsShape, budgets: Array<BudgetContext | undefined>) =>
    new HeadroomStatsReporter({
      fetchStats: async () => getStats(),
      postSavings: async (_delta, budget) => { budgets.push(budget); },
      intervalMs: 999_999,
      getBudgetEnv: () => ({ budgetUsd: 10, budgetPeriod: 'daily' }),
    });

  it('fires budgetReached=true only on the tick that crosses the cap', async () => {
    const budgets: Array<BudgetContext | undefined> = [];
    let stats = statsAt(1_000, 3);
    const reporter = makeReporter(() => stats, budgets);

    await reporter.tick(); // below the cap
    stats = statsAt(2_000, 10.5);
    await reporter.tick(); // crosses the cap
    stats = statsAt(3_000, 11);
    await reporter.tick(); // still over — must NOT re-fire

    expect(budgets).toHaveLength(3);
    expect(budgets[0]?.budgetReached).toBeUndefined();
    expect(budgets[1]?.budgetReached).toBe(true);
    expect(budgets[2]?.budgetReached).toBeUndefined();
  });

  it('fires on the first budgeted observation when already at/past the cap', async () => {
    const budgets: Array<BudgetContext | undefined> = [];
    const reporter = makeReporter(() => statsAt(1_000, 12), budgets);

    await reporter.tick();

    expect(budgets).toHaveLength(1);
    expect(budgets[0]?.budgetReached).toBe(true);
  });

  it('re-arms after a period reset drops the spend below the cap', async () => {
    const budgets: Array<BudgetContext | undefined> = [];
    let stats = statsAt(2_000, 10.5);
    const reporter = makeReporter(() => stats, budgets);

    await reporter.tick(); // crossing #1
    stats = statsAt(500, 0.5); // period reset: counters + spend drop
    await reporter.tick(); // below the cap again
    stats = statsAt(1_500, 10.2);
    await reporter.tick(); // crossing #2

    expect(budgets).toHaveLength(3);
    expect(budgets[0]?.budgetReached).toBe(true);
    expect(budgets[1]?.budgetReached).toBeUndefined();
    expect(budgets[2]?.budgetReached).toBe(true);
  });
});
