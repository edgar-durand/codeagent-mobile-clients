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
  /**
   * Poll delay behind a seam so tests stub it to a no-op (no real timers).
   * Production uses a short fixed delay between status re-probes.
   */
  sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Tuning for the start → poll-until-listening loop. Defaults keep the
 * worst-case wait a few seconds (well inside the 240s agent-spawn gate):
 * up to 2 `bd dolt start` attempts, each followed by up to 10 status polls
 * 500ms apart → ~5s per start attempt. Tests override with tiny values.
 */
export interface EnsureSharedServerOptions {
  /** How many times to (re)issue `bd dolt start` before giving up. */
  startAttempts?: number;
  /** How many `bd dolt status` polls per start attempt. */
  pollAttempts?: number;
  /** Delay between status polls, in ms. */
  pollDelayMs?: number;
}

const DEFAULTS = { startAttempts: 2, pollAttempts: 10, pollDelayMs: 500 } as const;

/**
 * Ensure the shared dolt sql-server is up. Idempotent: a running server is
 * reused (no second process). Strictly non-fatal — exhausting all retries
 * returns `{ up:false }` and the caller degrades to "beads memory unavailable
 * this run" rather than aborting the agent.
 *
 * On a cold codespace the `dolt` binary is freshly downloaded (~127MB) and the
 * detached `dolt sql-server` may not be listening on the FIRST status recheck.
 * A single start + single recheck therefore returned `{ up:false }` even though
 * the server came up a beat later → the agent spawned and hit a not-yet-
 * listening server ("Dolt server not running"). So after each `bd dolt start`
 * we POLL `bd dolt status` until it reports running, and RETRY the start itself
 * if it exits non-zero or the server never appears within the poll budget.
 */
export async function ensureSharedServer(
  adapter: BdAdapter,
  options: EnsureSharedServerOptions = {},
): Promise<SharedServerResult> {
  const startAttempts = options.startAttempts ?? DEFAULTS.startAttempts;
  const pollAttempts = options.pollAttempts ?? DEFAULTS.pollAttempts;
  const pollDelayMs = options.pollDelayMs ?? DEFAULTS.pollDelayMs;

  const probe = async (): Promise<boolean> => {
    const status = await adapter.run(['dolt', 'status']);
    return status.code === 0 && _daemonSeam.isRunning(status.stdout);
  };

  if (await probe()) {
    log.trace('beads', 'shared dolt sql-server already running — reusing');
    return { up: true, started: false };
  }

  for (let attempt = 1; attempt <= startAttempts; attempt++) {
    log.info(
      'beads',
      `shared dolt sql-server not running — starting (detached), attempt ${attempt}/${startAttempts}`,
    );
    const start = await adapter.run(['dolt', 'start']);
    if (start.code !== 0) {
      log.warn(
        'beads',
        `bd dolt start failed (code=${start.code}): ${start.stderr.slice(0, 200)} — retrying`,
      );
      // Don't poll a start that didn't even launch; go straight to the next
      // attempt (after a short beat so a transient cause can clear).
      if (attempt < startAttempts) await _daemonSeam.sleep(pollDelayMs);
      continue;
    }

    // Poll until the detached server is actually listening. On a cold box this
    // is where the ~127MB dolt download's tail latency is absorbed.
    for (let poll = 1; poll <= pollAttempts; poll++) {
      if (await probe()) {
        log.info('beads', `shared dolt sql-server up after ${poll} status poll(s)`);
        return { up: true, started: true };
      }
      if (poll < pollAttempts) await _daemonSeam.sleep(pollDelayMs);
    }
    log.warn(
      'beads',
      `shared dolt sql-server not listening after ${pollAttempts} polls (start attempt ${attempt}/${startAttempts})`,
    );
  }

  log.warn('beads', 'shared dolt sql-server still not reachable after all retries — non-fatal');
  return { up: false, started: false };
}
