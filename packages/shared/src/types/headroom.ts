/**
 * Headroom budget configuration and command types.
 * Used by the CLI to enable/disable cost-saving Headroom token compression
 * and track spending against configured budgets.
 */

export type HeadroomBudgetPeriod = 'hourly' | 'daily' | 'monthly';

/**
 * Command sent via relay to enable/disable/configure Headroom budget settings.
 * The `agentId` field is included because PairedSession has no agentId server-side,
 * so the relay command carries it for the CLI handler to guard on.
 */
export interface HeadroomBudgetCommand {
  budgetEnabled: boolean;
  budgetUsd?: number;
  budgetPeriod?: HeadroomBudgetPeriod;
  agentId?: string;
}

/**
 * Budget usage fields appended to the savings payload that the Headroom reporter
 * sends to the backend. Tracks spending in the current budget period.
 */
export interface HeadroomBudgetUsage {
  periodSpendUsd?: number;
  budgetUsd?: number;
  budgetPeriod?: HeadroomBudgetPeriod;
}
