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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { log } from '../logger';
import { buildBudgetProxyArgs } from './budget-args';
import { writeHeadroomProxyPidfile, headroomProxySpawnLockPath } from './proxy-pid';

/** Per-caller log shape — tag + message builders for the two failure modes. */
export interface HeadroomProxySpawnLogging {
  /** Logger tag (e.g. 'host-agent', 'headroom-supervisor', 'headroom-budget'). */
  tag: string;
  /** Message for the async spawn `error` event; receives `e.message`. */
  spawnErrorMsg: (detail: string) => string;
  /** Message for a synchronous spawn throw; receives the stringified error. */
  failureMsg: (detail: string) => string;
}

/** Options controlling the single-flight spawn lock. */
export interface HeadroomProxySpawnOpts {
  /**
   * Skip the single-flight guard. Deliberate one-shot callers that
   * `killHeadroomProxy()` immediately before (budget-relaunch, bootstrap
   * warm-start) pass `true` so their intentional relaunch is never swallowed
   * by a lock a supervisor happens to hold. The repeating liveness supervisor
   * leaves it `false` so two supervisors can't double-spawn.
   */
  force?: boolean;
}

/**
 * How long a spawn lock stays valid. A stale lock (older than this — the
 * spawning process died mid-launch) is stolen so the proxy can never get
 * permanently wedged. Sized above a cold ONNX-model load so the window during
 * which a starting proxy isn't answering /livez is covered by ONE spawn, not a
 * storm. Left to expire (never explicitly released) → doubles as a cooldown.
 */
export const PROXY_SPAWN_LOCK_TTL_MS = 45_000;

/**
 * Try to take the cross-process spawn lock (atomic O_EXCL create). Returns
 * true when acquired. If it already exists and is fresh, another process is
 * mid-spawn → false. If it exists but is stale (> TTL), steal it. All fs
 * errors degrade to "not acquired" — the lock is an optimization, never a
 * reason to crash a launch.
 */
function acquireSpawnLock(nowMs: number): boolean {
  const lockPath = headroomProxySpawnLockPath();
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    try {
      const { mtimeMs } = fs.statSync(lockPath);
      if (nowMs - mtimeMs > PROXY_SPAWN_LOCK_TTL_MS) {
        fs.writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o600 }); // steal stale
        return true;
      }
    } catch {
      /* raced away between create + stat — treat as held by the winner */
    }
    return false;
  }
}

/** Refresh the lock's mtime so a `force` spawn still blocks a concurrent
 *  supervisor for the TTL window (records "a spawn just happened"). */
function refreshSpawnLock(): void {
  try {
    const lockPath = headroomProxySpawnLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}

/** Where the spawned proxy's stdout+stderr land. Next to the relay's own
 *  debug logs so any incident triage finds it in the same directory. */
export function headroomProxyLogPath(): string {
  return path.join(os.homedir(), '.codeam', 'headroom-proxy.log');
}

/** Keep the captured log bounded — a long-lived box must never fill its disk
 *  with proxy chatter. Truncated (not rotated) once past the cap; the tail of
 *  the CURRENT boot is what matters for triage. */
const PROXY_LOG_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Open the append fd for the proxy log, truncating first when it has grown
 * past the cap. Returns `null` when the log can't be opened — callers then
 * fall back to `'ignore'` so an unwritable HOME can never block a respawn.
 */
function openProxyLogFd(): number | null {
  try {
    const p = headroomProxyLogPath();
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    try {
      if (fs.statSync(p).size > PROXY_LOG_MAX_BYTES) fs.truncateSync(p, 0);
    } catch {
      /* absent → nothing to truncate */
    }
    return fs.openSync(p, 'a', 0o600);
  } catch {
    return null;
  }
}

/**
 * Spawn the detached `headroom proxy --port 8787` best-effort — never throws.
 * Consumes the child's `error` event so Node doesn't raise an uncaught
 * exception when `headroom` is not on PATH (e.g. installed to a user-local
 * dir not yet on the current PATH); the try/catch only covers sync throws.
 */
export function spawnHeadroomProxy(
  logging: HeadroomProxySpawnLogging,
  opts: HeadroomProxySpawnOpts = {},
): void {
  try {
    // Single-flight across processes. A repeating supervisor (force !== true)
    // that loses the race backs off — another process already has a spawn in
    // flight, so a second `headroom proxy --port 8787` would only EADDRINUSE.
    // Deliberate one-shot callers (force === true) kill-then-spawn and must
    // win, but still refresh the lock so a concurrent supervisor stands down.
    const nowMs = Date.now();
    if (opts.force) {
      refreshSpawnLock();
    } else if (!acquireSpawnLock(nowMs)) {
      log.info(logging.tag, 'proxy spawn skipped — another spawn is in flight');
      return;
    }
    const proxyEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HEADROOM_KOMPRESS_BACKEND: 'onnx_cpu',
    };
    // ⚠️ NEVER `stdio: 'ignore'` here. A proxy that fails to start (bad flag,
    // EADDRINUSE, missing model cache, python traceback) then dies INVISIBLY:
    // the supervisor logs "confirmed down — respawning" forever with zero
    // diagnostics and the agent talks to a dead port. That is exactly what
    // made the 2026-08-13 incident undiagnosable from the box (12 respawns,
    // no trace, `~/.headroom.proxy.log` never even created). Capture both
    // streams to a bounded log instead — the cost is one fd.
    const logFd = openProxyLogFd();
    const proxy = spawn(
      'headroom',
      ['proxy', '--port', '8787', ...buildBudgetProxyArgs(proxyEnv)],
      {
        stdio: logFd === null ? 'ignore' : ['ignore', logFd, logFd],
        detached: true,
        env: proxyEnv,
      },
    );
    // The child owns the fd once spawned; close our copy so we don't leak one
    // per respawn in a long-lived relay.
    if (logFd !== null) {
      try {
        fs.closeSync(logFd);
      } catch {
        /* best-effort */
      }
    }
    proxy.once('error', (e: Error) => {
      log.warn(logging.tag, logging.spawnErrorMsg(e.message));
    });
    proxy.unref(); // don't keep the calling process alive for the proxy
    writeHeadroomProxyPidfile(proxy.pid);
  } catch (e) {
    log.warn(logging.tag, logging.failureMsg(e instanceof Error ? e.message : String(e)));
  }
}
