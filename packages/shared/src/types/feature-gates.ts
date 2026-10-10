// Per-user feature gates — capabilities that are NOT plan-tier limits
// (those live in `subscription.ts` / the backend `PlanLimitsService`)
// but are toggled on for specific cohorts (beta rollouts, kill-switches).
//
// The backend resolves these via `PlanLimitsService.getFeatureGates`
// and the clients consume the boolean map. Adding a gate here is the
// canonical way to introduce a beta-flagged capability — there is no
// parallel feature-flag system.

/**
 * Feature gates exposed to a client for the authenticated user.
 *
 * Every field defaults to `false` so an older client (or a transient
 * backend that can't resolve a gate) fails closed — the gated surface
 * stays hidden rather than flickering on.
 */
export interface FeatureGates {
  /**
   * Beads-backed agent memory & task graph (read-only mirror + mobile
   * surface + action relay). Generally available — ON for every user
   * by default. The backend's `BEADS_ENABLED` env var is an emergency
   * kill-switch (set falsy to disable for everyone). Gates the
   * `/api/beads/*` ingest + read + action endpoints and the mobile/web
   * Beads surface.
   */
  beads: boolean;
}

/** A single gate key — keep in sync with the `FeatureGates` fields. */
export type FeatureGateKey = keyof FeatureGates;

/** Fail-closed defaults. Every gate is OFF unless the backend turns it on. */
export const DEFAULT_FEATURE_GATES: FeatureGates = {
  beads: false,
};
