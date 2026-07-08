/**
 * Headroom budget-exceeded proxy recovery — the "Pause budget this session"
 * action relaunches the local Headroom proxy WITHOUT a `--budget` cap.
 *
 * Extracted from `runner.ts` so the baton {@link AcpDriver} can build its own
 * {@link createBudgetRecovery} instance without importing the heavy ACP-runner
 * module graph (which would drag a ~45 s import into the baton driver's tests).
 * The behaviour is byte-for-byte the same as the original inline runner code —
 * `runner.ts` now imports both symbols from here and re-exports
 * {@link buildRelaunchProxyEnv} for its existing test importers.
 */

import { killHeadroomProxy, writeHeadroomProxyPidfile } from '../../services/headroom/proxy-pid';
import { log } from '../../services/logger';

/**
 * Build the env object for relaunching the Headroom proxy WITHOUT any budget cap.
 *
 * Spreads `baseEnv` (normally `process.env`), sets `HEADROOM_KOMPRESS_BACKEND`
 * to lock the ONNX backend, then **deletes** both budget env keys so the
 * relaunched proxy starts with NO cap even when the headroom_budget handler
 * had previously written those keys into `process.env` on the same process.
 *
 * Pure + exported so the "pause clears budget env" invariant is
 * unit-tested without spawning a full ACP runner or a real proxy.
 */
export function buildRelaunchProxyEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...baseEnv, HEADROOM_KOMPRESS_BACKEND: 'onnx_cpu' };
  delete env['HEADROOM_BUDGET'];
  delete env['HEADROOM_BUDGET_PERIOD'];
  return env as NodeJS.ProcessEnv;
}

/**
 * Relaunch the Headroom proxy WITHOUT `--budget` args so it runs unbounded for
 * the rest of the session. Best-effort: a failed relaunch just leaves the agent
 * budget-capped. Resolves after a short settle so the proxy is accepting
 * connections again.
 */
export const relaunchProxyWithoutBudget = async (): Promise<void> => {
  const { spawn } = await import('node:child_process');
  // Kill the budget-capped proxy — targeted pidfile kill, falling back to
  // the legacy pkill pattern when no live recorded pid exists.
  killHeadroomProxy();
  // Brief settle so the port frees before relaunch.
  await new Promise<void>((r) => setTimeout(r, 500));
  // Re-spawn without budget args.
  // buildRelaunchProxyEnv clears both budget env keys so the "paused" proxy
  // inherits NO budget cap — neither flag nor env — even when the
  // headroom_budget handler had previously written them into process.env.
  const proxyEnv = buildRelaunchProxyEnv(process.env);
  try {
    const proxy = spawn(
      'headroom',
      ['proxy', '--port', '8787'],
      { stdio: 'ignore', detached: true, env: proxyEnv as NodeJS.ProcessEnv },
    );
    proxy.once('error', (e: Error) => {
      log.warn('acpRunner', `budget recovery proxy relaunch error (best-effort): ${e.message}`);
    });
    proxy.unref();
    writeHeadroomProxyPidfile(proxy.pid);
  } catch (e) {
    log.warn(
      'acpRunner',
      `budget recovery proxy relaunch failed (best-effort): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // Settle: give the proxy ~3 s to start accepting connections.
  await new Promise<void>((r) => setTimeout(r, 3_000));
};
