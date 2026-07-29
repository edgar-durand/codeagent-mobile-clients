// src/services/headroom/proxy-supervisor.ts
//
// Keeps the local Headroom compression proxy (:8787) ALIVE for the life of
// a session. The agent is configured with ANTHROPIC_BASE_URL=127.0.0.1:8787,
// so if the proxy dies mid-session — codespace resume, an OOM elsewhere, a
// crash — every subsequent turn hangs 90s with "adapter sent no updates"
// (2026-07-04, repeatedly, on a paused-then-woken codespace).
//
// The backend only (re)launches the proxy on a full wake bootstrap, which
// doesn't cover a proxy that dies WHILE the box stays up. The CLI is the one
// process that runs continuously during the session, so it's the correct
// owner of proxy liveness: a lightweight liveness probe on the existing
// heartbeat cadence respawns the proxy when it's gone. This is supervisor
// health-checking (the proxy's death has no event stream to react to), not
// the forbidden UI-state polling.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { log } from '../logger';
import { spawnHeadroomProxy } from './proxy-process';
import { isHeadroomProxyProcessAlive, headroomProxyPidfileAgeMs } from './proxy-pid';

export interface ProxySupervisorDeps {
  /** True when this box routes the agent through the Headroom proxy and
   *  should therefore keep it alive. False → skip entirely (native agents,
   *  Headroom-disabled boxes). */
  isConfigured: () => boolean;
  /** GET http://127.0.0.1:8787/livez → true when the proxy answers. */
  probeAlive: () => Promise<boolean>;
  /** Is the pid recorded in the pidfile a live OS process? Distinguishes a
   *  genuinely-dead proxy (respawn) from one that's alive but still loading
   *  the ONNX model, so /livez isn't answering yet (leave it be). */
  proxyProcessAlive: () => boolean;
  /** ms since the pidfile was last written (≈ since the last spawn), or null
   *  when no proxy was ever spawned. Cross-process startup grace. */
  proxyStartupAgeMs: () => number | null;
  /** (Re)spawn the detached proxy. */
  spawnProxy: () => void;
}

export type ProxyEnsureResult = 'skip' | 'alive' | 'starting' | 'respawned';

/**
 * Grace after a spawn during which a proxy that isn't answering /livez is
 * assumed to be loading the ONNX Kompress model (seconds of eager preload at
 * bind time), NOT dead. Respawning inside this window is the bug that caused
 * the respawn loop (EADDRINUSE storm every 15–75s, 2026-07-28): the model
 * was still loading, /livez 2s-timed-out, the old supervisor respawned, the
 * second `headroom proxy --port 8787` EADDRINUSE'd, and repeat. Must exceed a
 * cold model load. Pidfile-mtime based, so it's shared across all supervisors.
 */
export const PROXY_STARTUP_GRACE_MS = 45_000;

/**
 * One supervision pass. Pure orchestration (all I/O injected) so it's
 * unit-tested without a real proxy.
 *
 * `/livez` not answering is NOT proof the proxy is dead — it eager-loads the
 * model at bind time. Only respawn a proxy that is BOTH pid-confirmed-dead AND
 * past the startup grace; otherwise report `starting` and wait.
 */
export async function ensureHeadroomProxy(
  deps: ProxySupervisorDeps,
): Promise<ProxyEnsureResult> {
  if (!deps.isConfigured()) return 'skip';
  let alive = false;
  try {
    alive = await deps.probeAlive();
  } catch {
    alive = false;
  }
  if (alive) return 'alive';

  // Not answering /livez. Before respawning, rule out "up but still warming".
  if (deps.proxyProcessAlive()) return 'starting';
  const ageMs = deps.proxyStartupAgeMs();
  if (ageMs !== null && ageMs < PROXY_STARTUP_GRACE_MS) return 'starting';

  log.warn('headroom-supervisor', 'proxy :8787 is confirmed down — respawning');
  deps.spawnProxy();
  return 'respawned';
}

/** Does this box route the agent through Headroom :8787? Any one signal
 *  is enough: the explicit env flag, the codespace bootstrap env file, or
 *  a claude settings.json that points ANTHROPIC_BASE_URL at :8787. */
export function isHeadroomConfiguredReal(homeDir = os.homedir()): boolean {
  if (process.env.HEADROOM_ENABLED === '1') return true;
  const csEnv = path.join(homeDir, '.codeam', 'codespace-env.json');
  try {
    const j = JSON.parse(fs.readFileSync(csEnv, 'utf8')) as Record<string, unknown>;
    if (j.HEADROOM_ENABLED === '1' || j.HEADROOM_ENABLED === 1) return true;
  } catch {
    /* absent / unreadable → not a signal */
  }
  const settings = path.join(homeDir, '.claude', 'settings.json');
  try {
    if (fs.readFileSync(settings, 'utf8').includes('127.0.0.1:8787')) return true;
  } catch {
    /* absent → not a signal */
  }
  return false;
}

/** GET :8787/livez with a short timeout. */
export async function probeProxyAliveReal(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch('http://127.0.0.1:8787/livez', {
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Detached respawn — the shared spawnHeadroomProxy (setsid-like via
 *  detached+unref), re-deriving budget flags from the env so a capped
 *  user stays capped after a respawn. */
export function spawnProxyReal(): void {
  spawnHeadroomProxy({
    tag: 'headroom-supervisor',
    spawnErrorMsg: (detail) => `respawn error (best-effort): ${detail}`,
    failureMsg: (detail) => `respawn failed (best-effort): ${detail}`,
  });
}

export function makeRealProxySupervisorDeps(): ProxySupervisorDeps {
  return {
    isConfigured: () => isHeadroomConfiguredReal(),
    probeAlive: probeProxyAliveReal,
    proxyProcessAlive: () => isHeadroomProxyProcessAlive(),
    proxyStartupAgeMs: () => headroomProxyPidfileAgeMs(Date.now()),
    spawnProxy: spawnProxyReal,
  };
}
