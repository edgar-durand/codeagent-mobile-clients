// src/services/headroom/proxy-process.ts
//
// The ONE place that spawns the detached Headroom compression proxy
// (`headroom proxy --port 8787`). Three call sites share it:
//   • the self-hosted bootstrap warm-start (commands/host/headroom-bootstrap.ts),
//   • the liveness-supervisor respawn (proxy-supervisor.ts), and
//   • the budget-change direct relaunch (budget-relaunch.ts).
// Spawn args/env are byte-identical across all three: HEADROOM_KOMPRESS_BACKEND
// pinned to onnx_cpu (never import torch — absent by design), budget flags
// re-derived from the env via buildBudgetProxyArgs so a capped user stays
// capped, detached + unref'd (the caller never owns the proxy's lifetime),
// and the pid recorded for the targeted pidfile kill.
//
// Only the log tag + messages differ per caller, so they're injected.
import { spawn } from 'child_process';
import { log } from '../logger';
import { buildBudgetProxyArgs } from './budget-args';
import { writeHeadroomProxyPidfile } from './proxy-pid';

/** Per-caller log shape — tag + message builders for the two failure modes. */
export interface HeadroomProxySpawnLogging {
  /** Logger tag (e.g. 'host-agent', 'headroom-supervisor', 'headroom-budget'). */
  tag: string;
  /** Message for the async spawn `error` event; receives `e.message`. */
  spawnErrorMsg: (detail: string) => string;
  /** Message for a synchronous spawn throw; receives the stringified error. */
  failureMsg: (detail: string) => string;
}

/**
 * Spawn the detached `headroom proxy --port 8787` best-effort — never throws.
 * Consumes the child's `error` event so Node doesn't raise an uncaught
 * exception when `headroom` is not on PATH (e.g. installed to a user-local
 * dir not yet on the current PATH); the try/catch only covers sync throws.
 */
export function spawnHeadroomProxy(logging: HeadroomProxySpawnLogging): void {
  try {
    const proxyEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HEADROOM_KOMPRESS_BACKEND: 'onnx_cpu',
    };
    const proxy = spawn(
      'headroom',
      ['proxy', '--port', '8787', ...buildBudgetProxyArgs(proxyEnv)],
      {
        stdio: 'ignore',
        detached: true,
        env: proxyEnv,
      },
    );
    proxy.once('error', (e: Error) => {
      log.warn(logging.tag, logging.spawnErrorMsg(e.message));
    });
    proxy.unref(); // don't keep the calling process alive for the proxy
    writeHeadroomProxyPidfile(proxy.pid);
  } catch (e) {
    log.warn(logging.tag, logging.failureMsg(e instanceof Error ? e.message : String(e)));
  }
}
