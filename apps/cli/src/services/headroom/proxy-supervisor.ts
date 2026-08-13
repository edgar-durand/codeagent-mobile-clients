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
import * as net from 'net';
import { log } from '../logger';
import { spawnHeadroomProxy } from './proxy-process';
import {
  isHeadroomProxyProcessAlive,
  headroomProxyPidfileAgeMs,
  killHeadroomProxy,
  adoptRunningProxy,
} from './proxy-pid';

export interface ProxySupervisorDeps {
  /** True when this box routes the agent through the Headroom proxy and
   *  should therefore keep it alive. False → skip entirely (native agents,
   *  Headroom-disabled boxes). */
  isConfigured: () => boolean;
  /** GET http://127.0.0.1:8787/livez → true when the proxy answers. */
  probeAlive: () => Promise<boolean>;
  /**
   * Can a TCP connection be established to :8787? This is a WEAKER signal than
   * `/livez` and that is exactly the point: `ConnectionRefused` — the error the
   * user actually sees — happens if and only if nothing is LISTENING. Once the
   * socket accepts, the agent's request is queued/served instead of refused,
   * even while the proxy is still eager-loading the ONNX model. Optional so
   * existing test doubles keep compiling (absent → `/livez` only, prior behavior).
   */
  probePortOpen?: () => Promise<boolean>;
  /** Is the pid recorded in the pidfile a live OS process? Distinguishes a
   *  genuinely-dead proxy (respawn) from one that's alive but still loading
   *  the ONNX model, so /livez isn't answering yet (leave it be). */
  proxyProcessAlive: () => boolean;
  /** ms since the pidfile was last written (≈ since the last spawn), or null
   *  when no proxy was ever spawned. Cross-process startup grace. */
  proxyStartupAgeMs: () => number | null;
  /** (Re)spawn the detached proxy. */
  spawnProxy: () => void;
  /** Claim a live `headroom proxy` we did not spawn into our pidfile so it
   *  becomes supervisable instead of being killed as an unknown. Returns the
   *  adopted pid, or null when there is nothing to adopt. Optional so existing
   *  test doubles keep compiling (absent → no adoption, prior behavior). */
  adoptRunningProxy?: () => number | null;
  /** Force-(re)spawn, bypassing the single-flight backoff — used by the
   *  pre-turn readiness ensure when the proxy is CONFIRMED down (a backed-off
   *  no-op there would leave the turn hitting a dead port). Optional: falls back
   *  to spawnProxy when absent. */
  spawnProxyForce?: () => void;
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
 * How long the PRE-TURN ensure waits for a respawned proxy. Must exceed a COLD
 * ONNX Kompress load on a BUSY box: 60 s was not enough live (2026-08-13 — the
 * wait expired and the turn was sent at a still-refusing port). The wait now
 * also releases on an accepting socket, so this ceiling is only the backstop
 * for a proxy that never binds at all.
 */
export const PRE_TURN_READY_TIMEOUT_MS = 150_000;

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
  // ⚠️ This guard is only SOUND because isHeadroomProxyProcessAlive() now
  // verifies the pid is ACTUALLY our headroom proxy (cmdline), not just that
  // SOME process holds that pid. Pre-fix, a zombie/reused pid (common after a
  // codespace resume/container restart) reported "alive" here → 'starting'
  // FOREVER → the supervisor never respawned (Rafael 2026-08-08, dead ~9 min).
  if (deps.proxyProcessAlive()) return 'starting';
  const ageMs = deps.proxyStartupAgeMs();
  if (ageMs !== null && ageMs < PROXY_STARTUP_GRACE_MS) return 'starting';

  // ADOPT before declaring death. A proxy launched by the codespace bootstrap
  // shell (or by a previous CLI generation) has no pidfile of ours, so every
  // check above reads "dead" even though it is healthy and serving — and the
  // respawn path would then SIGTERM it. Claiming it into our pidfile makes it
  // supervisable instead of collateral damage. (2026-08-13.)
  const adopted = deps.adoptRunningProxy?.() ?? null;
  if (adopted !== null) {
    log.info('headroom-supervisor', `adopted an already-running proxy (pid ${adopted})`);
    return 'starting';
  }

  log.warn('headroom-supervisor', 'proxy :8787 is confirmed down — respawning');
  // Force (kill-then-spawn) so a WEDGED proxy still holding :8787 can't
  // EADDRINUSE the respawn. Falls back to the plain spawn when no force dep.
  (deps.spawnProxyForce ?? deps.spawnProxy)();
  return 'respawned';
}

/**
 * PRE-TURN readiness ensure. Unlike {@link ensureHeadroomProxy} (a
 * fire-and-forget supervision tick on the heartbeat), this is called right
 * before a turn is sent and WAITS: if the proxy is configured but not answering
 * `/livez`, it FORCE-respawns and polls `/livez` until ready (bounded). This is
 * the self-heal for the Rafael 2026-08-08 incident — on a codespace resume /
 * host-agent restart the detached :8787 proxy can be SIGTERM'd and NOT
 * relaunched, leaving the agent's `ANTHROPIC_BASE_URL` pointing at a dead port,
 * so every turn fails "API Error: Unable to connect to API (ConnectionRefused)".
 * The 30 s heartbeat supervisor eventually respawns it, but a turn fired inside
 * that window still fails; ensuring readiness AT THE TURN closes the gap.
 *
 * Cheap no-op (one `/livez`) when the proxy already answers OR Headroom isn't
 * configured. Never throws — a failed ensure degrades to the normal turn path
 * (which then surfaces the real error). Bounded by a poll COUNT (not wall-clock)
 * so it's deterministic under an injected clock in tests.
 */
export async function ensureHeadroomProxyReady(
  deps: ProxySupervisorDeps,
  opts: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  if (!deps.isConfigured()) return true;
  if (await deps.probeAlive().catch(() => false)) return true;

  log.warn(
    'headroom-supervisor',
    'proxy :8787 not answering before a turn — force-respawning + waiting for readiness',
  );
  (deps.spawnProxyForce ?? deps.spawnProxy)();

  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 1500;
  const maxPolls = Math.max(1, Math.ceil((opts.timeoutMs ?? PRE_TURN_READY_TIMEOUT_MS) / pollMs));
  for (let i = 0; i < maxPolls; i += 1) {
    await sleep(pollMs);
    // Release on EITHER signal. `/livez` means fully ready; an accepting SOCKET
    // means the turn can no longer be refused, which is the actual failure we
    // are preventing. Requiring the stricter one made a cold ONNX load on a
    // busy box blow the budget ("still not ready … proceeding anyway",
    // observed live 2026-08-13) even though the port was already accepting.
    const elapsed = ((i + 1) * pollMs) / 1000;
    if (await deps.probeAlive().catch(() => false)) {
      log.info('headroom-supervisor', `proxy :8787 ready after ~${elapsed}s`);
      return true;
    }
    if (await (deps.probePortOpen?.() ?? Promise.resolve(false)).catch(() => false)) {
      log.info(
        'headroom-supervisor',
        `proxy :8787 accepting connections after ~${elapsed}s (still warming — turn is safe to send)`,
      );
      return true;
    }
  }
  log.warn('headroom-supervisor', 'proxy :8787 still not ready after respawn wait — proceeding anyway');
  return false;
}

/**
 * Does this box route the agent through Headroom :8787? Any one signal is
 * enough.
 *
 * ⚠️ ORDER OF TRUST — `~/.codeam/headroom-config.json` FIRST. That file is
 * OUR OWN persisted state, written by `setupHeadroomForSelfHosted` /
 * `configureHeadroom` the moment we enable Headroom on this box, so it is the
 * only signal that is authoritative and version-independent.
 *
 * Every other signal is an inference about a THIRD-PARTY tool's config layout
 * and each has already gone stale once:
 *  - `~/.claude/settings.json` containing `127.0.0.1:8787` — **headroom ≥ 0.33
 *    no longer writes a base URL there**; it routes via a `PreToolUse` hook
 *    (`headroom init hook ensure`). A box on 0.33 therefore looked
 *    "not configured" to the pre-turn self-heal, which then silently no-op'd
 *    while every turn failed `ConnectionRefused` (Edgar, codespace
 *    `codeagent-mobile-gp596vpwgr9fggp`, 2026-08-13: 6 prompts, 3
 *    ConnectionRefused, `pre-turn heals: 0` in the ACP process's debug log).
 *  - `codespace-env.json` `HEADROOM_ENABLED` — only written on the codespace
 *    bootstrap rail, absent on the self-hosted/wrapper rail.
 *  - `HEADROOM_ENABLED=1` in env — only present in processes the host-agent
 *    spawned with `readHeadroomChildEnv()`, not in every relay child.
 *
 * Consequence to preserve: a FALSE here disables the proxy self-heal, so the
 * agent talks to a dead port with no recovery. Bias the predicate toward
 * "configured" — a false positive only costs one cheap `/livez` probe.
 */
export function isHeadroomConfiguredReal(homeDir = os.homedir()): boolean {
  // 1. Our own persisted state — authoritative, survives Headroom upgrades.
  const ownConfig = path.join(homeDir, '.codeam', 'headroom-config.json');
  try {
    const j = JSON.parse(fs.readFileSync(ownConfig, 'utf8')) as { enabled?: unknown };
    if (j.enabled === true) return true;
  } catch {
    /* absent / unreadable → fall through to the inferred signals */
  }
  if (process.env.HEADROOM_ENABLED === '1') return true;
  const csEnv = path.join(homeDir, '.codeam', 'codespace-env.json');
  try {
    const j = JSON.parse(fs.readFileSync(csEnv, 'utf8')) as Record<string, unknown>;
    if (j.HEADROOM_ENABLED === '1' || j.HEADROOM_ENABLED === 1) return true;
  } catch {
    /* absent / unreadable → not a signal */
  }
  // Legacy/base-URL layouts (headroom < 0.33) AND the hook layout (>= 0.33):
  // either mention is proof this box's Claude is wired to Headroom.
  const settings = path.join(homeDir, '.claude', 'settings.json');
  try {
    const raw = fs.readFileSync(settings, 'utf8');
    if (raw.includes('127.0.0.1:8787') || raw.includes('headroom init hook')) return true;
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

/**
 * Can we open a TCP connection to :8787? True the instant the proxy's socket
 * accepts — which is precisely when `ConnectionRefused` becomes impossible,
 * regardless of whether the model has finished loading.
 */
export async function probeProxyPortOpenReal(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: 8787 });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
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
    probePortOpen: probeProxyPortOpenReal,
    proxyProcessAlive: () => isHeadroomProxyProcessAlive(),
    proxyStartupAgeMs: () => headroomProxyPidfileAgeMs(Date.now()),
    adoptRunningProxy: () => adoptRunningProxy(),
    spawnProxy: spawnProxyReal,
    spawnProxyForce: () => {
      // Kill any wedged/zombie holder FIRST so the fresh proxy can bind :8787
      // (a wedged process still holding the port would otherwise EADDRINUSE the
      // respawn). Best-effort + synchronous; then force-spawn past the lock.
      killHeadroomProxy();
      spawnHeadroomProxy(
        {
          tag: 'headroom-supervisor',
          spawnErrorMsg: (detail) => `force-respawn error (best-effort): ${detail}`,
          failureMsg: (detail) => `force-respawn failed (best-effort): ${detail}`,
        },
        { force: true },
      );
    },
  };
}
