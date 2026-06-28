// src/services/headroom/budget-args.ts
/**
 * Build the `--budget` / `--budget-period` CLI args for the headroom proxy.
 *
 * Verified live against headroom v0.27.0:
 *   headroom proxy --port 8787 --budget <USD> --budget-period [hourly|daily|monthly]
 *
 * When `HEADROOM_BUDGET` is not set in `env`, returns `[]` so the proxy launch
 * is byte-identical to the pre-budget behaviour (additive, zero default change).
 *
 * @param env - An env-var map (e.g. `process.env` or the child env record).
 *              Only `HEADROOM_BUDGET` and `HEADROOM_BUDGET_PERIOD` are read.
 * @returns   `['--budget', '<usd>', '--budget-period', '<period>']` when a budget
 *            is configured, or `[]` when it is not.
 */
export function buildBudgetProxyArgs(env: Record<string, string | undefined>): string[] {
  const budget = env['HEADROOM_BUDGET'];
  if (!budget) return [];
  const period = env['HEADROOM_BUDGET_PERIOD'] ?? 'daily';
  return ['--budget', budget, '--budget-period', period];
}
