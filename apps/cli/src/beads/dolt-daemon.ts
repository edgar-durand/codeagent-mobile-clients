import type { BdAdapter } from './bd-adapter';
import { log } from '../services/logger';

/**
 * Shared `dolt sql-server` lifecycle (spec D4/D8, finished per §3c/D15). bd's
 * shared-server mode runs ONE server, globally, at `~/.beads/shared-server/`
 * on port 3308, serving every project's per-prefix database. All bd DB ops —
 * memory especially — fail with `connection refused` until it's up, so the
 * provisioner must ensure it before anything else (spike-verified 2026-06-10).
 *
 * We OWN the lifecycle the way the spec's D8 intends: reuse-if-running, else
 * start (bd starts it detached itself — `bd dolt start` returns once the
 * server is listening), health-checked via `bd dolt status`. We deliberately
 * do NOT stop it on teardown: it's shared across sessions/agents and persists.
 *
 * The adapter injects `BEADS_DOLT_SHARED_SERVER=1` into every run (see
 * bd-adapter), so these `bd dolt …` commands target the shared server.
 */

export interface SharedServerResult {
  /** The shared dolt sql-server is reachable after this call. */
  up: boolean;
  /** True iff THIS call started it (false = it was already running). */
  started: boolean;
}

export const _daemonSeam = {
  /**
   * Parse `bd dolt status` stdout. Running blocks lead with
   * `Dolt server: running`; down blocks say `Dolt server: not running`.
   * Match the affirmative form explicitly so "not running" can't false-positive.
   */
  isRunning: (statusStdout: string): boolean =>
    /Dolt server:\s*running/i.test(statusStdout),
};

/**
 * Ensure the shared dolt sql-server is up. Idempotent: a running server is
 * reused (no second process). Strictly non-fatal — a failed start returns
 * `{ up:false }` and the caller degrades to "beads memory unavailable this
 * run" rather than aborting the agent.
 */
export async function ensureSharedServer(adapter: BdAdapter): Promise<SharedServerResult> {
  const status = await adapter.run(['dolt', 'status']);
  if (status.code === 0 && _daemonSeam.isRunning(status.stdout)) {
    log.trace('beads', 'shared dolt sql-server already running — reusing');
    return { up: true, started: false };
  }

  log.info('beads', 'shared dolt sql-server not running — starting (detached)');
  const start = await adapter.run(['dolt', 'start']);
  if (start.code !== 0) {
    log.warn(
      'beads',
      `bd dolt start failed (code=${start.code}): ${start.stderr.slice(0, 200)} — beads memory unavailable this run`,
    );
    return { up: false, started: false };
  }

  // Re-probe so we only report up:true once the server is actually listening.
  const recheck = await adapter.run(['dolt', 'status']);
  const up = recheck.code === 0 && _daemonSeam.isRunning(recheck.stdout);
  if (!up) {
    log.warn('beads', 'shared dolt sql-server still not reachable after start — non-fatal');
  }
  return { up, started: up };
}
