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

// ─── Token-usage report (Headroom `/stats-history` projection) ───────────────

/** One provider/model slice inside a rollup bucket. */
export interface HeadroomUsageSlice {
  /** Tokens Headroom removed in this bucket (a DELTA, not cumulative). */
  tokens_saved: number;
  compression_savings_usd_delta: number;
  total_input_tokens_delta: number;
  total_input_cost_usd_delta: number;
}

/**
 * One rollup bucket. ⚠️ The `*_delta` fields (and `tokens_saved`) are
 * PER-BUCKET; the bare `total_*` fields are the CUMULATIVE value at the
 * bucket's end. Chart the deltas, show the totals as headline figures.
 */
export interface HeadroomUsageBucket {
  /** Bucket start, UTC ISO-8601. */
  timestamp: string;
  tokens_saved: number;
  compression_savings_usd_delta: number;
  total_tokens_saved: number;
  compression_savings_usd: number;
  total_input_tokens_delta: number;
  total_input_tokens: number;
  total_input_cost_usd_delta: number;
  total_input_cost_usd: number;
  by_provider: Record<string, HeadroomUsageSlice>;
  by_model: Record<string, HeadroomUsageSlice>;
}

export type HeadroomUsageGranularity = 'hourly' | 'daily' | 'weekly' | 'monthly';

/** Lifetime / current-window totals. */
export interface HeadroomUsageTotals {
  requests: number;
  tokens_saved: number;
  compression_savings_usd: number;
  total_input_tokens: number;
  total_input_cost_usd: number;
}

/**
 * The token-usage report the CLI relays for the `headroom_usage` command — a
 * TRIMMED projection of the proxy's `GET /stats-history` (schema_version 3,
 * verified live against headroom 0.27.0).
 *
 * ⚠️ Trimmed ON THE BOX before it ever leaves, for three reasons:
 *  - the raw response is ~150 KB (and `history_mode=full` is ~1.1 MB) — too
 *    heavy for the command relay; dropping the raw `history[]` and capping the
 *    hourly series brings it to ~23 KB.
 *  - `history[]` carries CUMULATIVE counters that would have to be diffed,
 *    while `series[]` already provides per-bucket deltas AND the
 *    `by_model` / `by_provider` breakdown (richer than Headroom's own CSV
 *    export, which has no model column).
 *  - the proxy's `storage_path` leaks a local filesystem path (including the
 *    OS username) and is stripped.
 */
export interface HeadroomUsageReport {
  /** Headroom's own payload schema version (3 at time of writing). */
  schemaVersion: number;
  /** When the proxy generated the snapshot (UTC ISO-8601). */
  generatedAt: string;
  /** Proxy version that produced it, when known. */
  proxyVersion?: string;
  /** Durable, all-time totals across proxy restarts. */
  lifetime: HeadroomUsageTotals;
  /** The proxy's current display session (rolls over after inactivity). */
  currentSession?: HeadroomUsageTotals & {
    savings_percent?: number;
    started_at?: string | null;
    last_activity_at?: string | null;
  };
  /** Rollups. `hourly` is capped to the most recent buckets to bound size. */
  series: Partial<Record<HeadroomUsageGranularity, HeadroomUsageBucket[]>>;
  /** The proxy's retention policy, so the UI can state the window honestly. */
  retention?: {
    max_history_points?: number;
    max_history_age_days?: number;
  };
}

/** Result of the `headroom_usage` relay command. */
export interface HeadroomUsageResult {
  /** False when the proxy isn't reachable / Headroom isn't active here. */
  available: boolean;
  report?: HeadroomUsageReport;
  /** Human-readable reason when `available` is false. */
  error?: string;
}

/** Relay command type for pulling the token-usage report. */
export const HEADROOM_USAGE_COMMAND = 'headroom_usage';
