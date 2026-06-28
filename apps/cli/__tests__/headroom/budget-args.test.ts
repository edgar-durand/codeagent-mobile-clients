// __tests__/headroom/budget-args.test.ts
import { describe, it, expect } from 'vitest';
import { buildBudgetProxyArgs } from '../../src/services/headroom/budget-args';

describe('buildBudgetProxyArgs', () => {
  it('returns flags when budget and period are both set', () => {
    expect(
      buildBudgetProxyArgs({ HEADROOM_BUDGET: '10', HEADROOM_BUDGET_PERIOD: 'daily' }),
    ).toEqual(['--budget', '10', '--budget-period', 'daily']);
  });

  it('defaults period to daily when HEADROOM_BUDGET_PERIOD is absent', () => {
    expect(buildBudgetProxyArgs({ HEADROOM_BUDGET: '5' })).toEqual([
      '--budget',
      '5',
      '--budget-period',
      'daily',
    ]);
  });

  it('returns [] when HEADROOM_BUDGET is not set (no behaviour change)', () => {
    expect(buildBudgetProxyArgs({})).toEqual([]);
  });

  it('returns [] when HEADROOM_BUDGET is undefined', () => {
    expect(buildBudgetProxyArgs({ HEADROOM_BUDGET: undefined })).toEqual([]);
  });

  it('honours hourly period', () => {
    expect(
      buildBudgetProxyArgs({ HEADROOM_BUDGET: '2.5', HEADROOM_BUDGET_PERIOD: 'hourly' }),
    ).toEqual(['--budget', '2.5', '--budget-period', 'hourly']);
  });

  it('honours monthly period', () => {
    expect(
      buildBudgetProxyArgs({ HEADROOM_BUDGET: '100', HEADROOM_BUDGET_PERIOD: 'monthly' }),
    ).toEqual(['--budget', '100', '--budget-period', 'monthly']);
  });
});
