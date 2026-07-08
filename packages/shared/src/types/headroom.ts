/**
 * Headroom budget configuration and command types.
 * Used by the CLI to enable/disable cost-saving Headroom token compression
 * and track spending against configured budgets.
 *
 * CANONICAL WIRE OWNER: this file (`@codeam/shared`) owns the wire
 * protocol, per the cross-repo rule. The backend repo keeps hand-synced
 * MIRRORS (`codeagent-mobile/packages/shared/src/types/headroom.ts` for
 * mobile/landing, `codeagent-mobile/apps/api-v2/src/common/types/headroom.ts`
 * for the backend); a drift-check script at
 * `codeagent-mobile/scripts/check-shared-drift` compares them.
 */

export type HeadroomBudgetPeriod = 'hourly' | 'daily' | 'monthly';

/**
 * Install-progress milestone emitted on the `headroom_progress` SSE event while
 * a session is provisioning Headroom on-demand. Must stay byte-for-byte aligned
 * with the backend's `HEADROOM_STEPS` validator
 * (`apps/api-v2/src/headroom/headroom.controller.ts`) and the mobile store —
 * the backend 400s (`INVALID_STEP`) on any value outside this set. Note
 * `'provisioning'` is a `HeadroomStatus['state']`, NOT a step.
 */
export type HeadroomStep = 'pip' | 'model' | 'init' | 'proxy' | 'ready';

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
  /** True iff this turn pushed periodSpendUsd to or past budgetUsd. */
  budgetReached?: boolean;
}

/**
 * Headroom cost-saving state for a session — carried on the `headroom_status`
 * SSE event and snapshotted by the backend into Redis `headroom:<sessionId>`.
 * Mirrored byte-for-byte in `apps/api-v2/src/common/types/headroom.ts`.
 */
export interface HeadroomStatus {
  state: 'enabled' | 'disabled' | 'error' | 'provisioning';
  running?: boolean;
  agent?: string;
  savings?: number;
  error?: string;
}
