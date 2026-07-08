import { describe, it, expect } from 'vitest';
import type {
  HeadroomBudgetPeriod,
  HeadroomBudgetCommand,
  HeadroomBudgetUsage,
  HeadroomStatus,
  HeadroomStep,
} from '../src/types/headroom';

describe('Headroom budget types', () => {
  it('HeadroomBudgetPeriod accepts valid period values', () => {
    const periods: HeadroomBudgetPeriod[] = ['hourly', 'daily', 'monthly'];
    expect(periods.length).toBe(3);
  });

  it('HeadroomBudgetCommand has required budgetEnabled field', () => {
    const cmd: HeadroomBudgetCommand = { budgetEnabled: true };
    expect(cmd.budgetEnabled).toBe(true);
  });

  it('HeadroomBudgetCommand supports optional budget fields', () => {
    const cmd: HeadroomBudgetCommand = {
      budgetEnabled: true,
      budgetUsd: 10.0,
      budgetPeriod: 'daily',
      agentId: 'claude',
    };
    expect(cmd.budgetUsd).toBe(10.0);
    expect(cmd.budgetPeriod).toBe('daily');
    expect(cmd.agentId).toBe('claude');
  });

  it('HeadroomBudgetUsage has optional spending fields', () => {
    const usage: HeadroomBudgetUsage = {
      periodSpendUsd: 5.5,
      budgetUsd: 10.0,
      budgetPeriod: 'monthly',
    };
    expect(usage.periodSpendUsd).toBe(5.5);
    expect(usage.budgetUsd).toBe(10.0);
    expect(usage.budgetPeriod).toBe('monthly');
  });

  it('HeadroomBudgetUsage carries the budgetReached flag the toast keys on', () => {
    const usage: HeadroomBudgetUsage = { periodSpendUsd: 10, budgetUsd: 10, budgetReached: true };
    expect(usage.budgetReached).toBe(true);
  });

  it('HeadroomStep enumerates the on-demand install milestones (no state values)', () => {
    const steps: HeadroomStep[] = ['pip', 'model', 'init', 'proxy', 'ready'];
    expect(steps.length).toBe(5);
  });

  it('HeadroomStatus.state includes the provisioning state', () => {
    const status: HeadroomStatus = { state: 'provisioning' };
    expect(status.state).toBe('provisioning');
  });
});
