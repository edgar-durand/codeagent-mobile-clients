// src/services/headroom/proxy-pid.ts
//
// Pidfile-based lifecycle for the detached Headroom proxy (:8787).
//
// The proxy is spawned detached + unref'd with NO handle retained, so every
// teardown used to be a blind `pkill -TERM -f 'headroom.*proxy'` — a pattern
// kill that can match unrelated processes whose argv happens to contain
// "headroom … proxy" and silently no-ops where procps is absent. Spawn sites
// now record the child pid via {@link writeHeadroomProxyPidfile} (the pidfile
// lives next to `~/.codeam/headroom-config.json`), and kill sites call
// {@link killHeadroomProxy}, which SIGTERMs that exact pid and falls back to
// the legacy pkill pattern ONLY when no live pidfile pid exists (proxy started
// by an older CLI, stale pidfile after a reboot, …).

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Pidfile path — sibling of `~/.codeam/headroom-config.json`. */
export function headroomProxyPidfilePath(): string {
  return path.join(os.homedir(), '.codeam', 'headroom-proxy.pid');
}

/** Cross-process single-flight spawn lock — sibling of the pidfile. Held (via
 *  an O_EXCL create with a TTL) while a spawn is in flight so two CLI processes
 *  (e.g. two relay supervisors on one box) can't both launch
 *  `headroom proxy --port 8787` at once → EADDRINUSE → the respawn loop. */
export function headroomProxySpawnLockPath(): string {
  return path.join(os.homedir(), '.codeam', 'headroom-proxy.spawn.lock');
}

/**
 * Record the detached proxy's pid. Best-effort: a spawn that failed
 * asynchronously (ENOENT) has `pid === undefined` and is skipped; fs errors
 * are swallowed — the pidfile is an optimization over the pkill fallback,
 * never a reason to fail a proxy launch.
 */
export function writeHeadroomProxyPidfile(pid: number | undefined): void {
  if (!pid) return;
  try {
    const file = headroomProxyPidfilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${pid}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    /* best-effort — killHeadroomProxy falls back to pkill without it */
  }
}

/** Read the recorded proxy pid, or `null` when absent/unparseable. */
export function readHeadroomProxyPidfile(): number | null {
  try {
    const pid = Number(fs.readFileSync(headroomProxyPidfilePath(), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Signal 0 liveness probe. EPERM (alive, not ours) counts as NOT ours →
 *  treated as dead so we never SIGTERM a pid the CLI didn't spawn. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Does the pid's /proc/<pid>/cmdline actually look like the Headroom proxy?
 * The pidfile pid alone is NOT trustworthy across a codespace resume / container
 * restart: (a) the pid can be REUSED by an unrelated process (a bare
 * `process.kill(pid,0)` then reports "alive" for something that isn't our proxy),
 * and (b) a SIGTERM'd-but-unreaped proxy lingers as a ZOMBIE that `kill(pid,0)`
 * also reports "alive" (its cmdline is empty). Both made the liveness supervisor
 * return 'starting' FOREVER and never respawn — the Rafael 2026-08-08 "dead 9 min"
 * bug. Verifying the cmdline mentions `headroom` + `proxy` rules out both. Linux
 * only (/proc); other platforms fall back to the bare pid probe (best-effort).
 */
function pidLooksLikeProxy(pid: number, opts: { strict?: boolean } = {}): boolean {
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').toLowerCase();
    if (cmd.trim() === '') return false; // zombie/defunct → not serving
    return cmd.includes('headroom') && cmd.includes('proxy');
  } catch {
    // ⚠️ STRICT is for SCANNING every pid on the box (findRunningProxyPid).
    // There, "I couldn't read the cmdline" must mean NO — the lenient fallback
    // below degenerates to a bare liveness probe, which every live pid passes,
    // so the first unreadable /proc entry (EACCES under hidepid, or a pid that
    // exited mid-scan) would be adopted as "the proxy" and SIGTERM'd. On a
    // shared host that is someone else's process. A scan may only ever act on a
    // POSITIVELY identified proxy.
    if (opts.strict) return false;
    // No /proc (macOS/Windows) or the pid is gone. If the pid is gone,
    // isPidAlive already returns false; when /proc is simply absent we can't
    // verify the cmdline, so trust the bare probe (dev machines, not the
    // codespace/self-hosted boxes this guard protects).
    return isPidAlive(pid);
  }
}

/**
 * Is the proxy recorded in the pidfile a live process that is ACTUALLY our
 * Headroom proxy? Used by the liveness supervisor to distinguish "proxy is
 * genuinely dead / gone / a reused pid → respawn" from "proxy is alive but
 * /livez isn't answering yet" (it eager-loads the ONNX Kompress model at bind
 * time — seconds during which the process is up but not ready). Respawning in
 * that window races the starting proxy → a 2nd `headroom proxy --port 8787` →
 * EADDRINUSE → the respawn loop.
 */
export function isHeadroomProxyProcessAlive(): boolean {
  const pid = readHeadroomProxyPidfile();
  return pid !== null && isPidAlive(pid) && pidLooksLikeProxy(pid);
}

/**
 * Wall-clock ms since the pidfile was last written (i.e. since the last
 * spawn), or `null` when there's no pidfile. The supervisor uses this as a
 * cross-process startup grace: every relay supervisor sees the same pidfile
 * mtime, so a proxy spawned by ANY process is given time to finish loading
 * the model before ANY other process considers it dead.
 */
export function headroomProxyPidfileAgeMs(nowMs: number): number | null {
  try {
    const { mtimeMs } = fs.statSync(headroomProxyPidfilePath());
    return Math.max(0, nowMs - mtimeMs);
  } catch {
    return null;
  }
}

/** Legacy pattern kill — the pre-pidfile behavior, kept as the fallback for
 *  proxies launched before the pidfile existed. */
function pkillFallback(): void {
  try {
    const killer = spawn('pkill', ['-TERM', '-f', 'headroom.*proxy'], {
      detached: true,
      stdio: 'ignore',
    });
    // `spawn` emits ENOENT (pkill/procps absent on a minimal box) as an
    // ASYNC 'error' event — the try/catch only guards the synchronous call.
    killer.once('error', () => { /* best-effort */ });
    killer.unref();
  } catch {
    /* best-effort — proxy may already be dead */
  }
}

/**
 * Stop the Headroom proxy. SIGTERM the pidfile-recorded pid when it's alive
 * (targeted — can't hit unrelated processes); otherwise clear any stale
 * pidfile and fall back to the legacy `pkill -TERM -f 'headroom.*proxy'`.
 * Best-effort and synchronous at every call site — never throws.
 */
/**
 * Scan for a LIVE `headroom proxy` process we may not have spawned ourselves
 * (the codespace bootstrap launches it from a shell, and a previous CLI
 * generation left no pidfile). Returns its pid, or null.
 *
 * This exists so the supervisor can ADOPT a healthy proxy instead of killing
 * it. Without adoption, a proxy with no matching pidfile reads as
 * "confirmed down" → `killHeadroomProxy()` → the blind
 * `pkill -f 'headroom.*proxy'` fallback SIGTERMs a perfectly healthy proxy —
 * the same "we were killing it ourselves" failure the runbook recorded on
 * 2026-07-04, re-entering through a different door (2026-08-13).
 *
 * /proc-only by design: no `pgrep`/`pkill` dependency (absent on minimal
 * boxes) and no pattern that could match an unrelated process — we require
 * BOTH `headroom` and `proxy` in the cmdline, the same predicate
 * {@link isHeadroomProxyProcessAlive} uses.
 */
export function findRunningProxyPid(): number | null {
  let entries: string[];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return null; // no /proc (macOS/Windows dev machines) → nothing to adopt
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    if (pidLooksLikeProxy(pid, { strict: true })) return pid;
  }
  return null;
}

/**
 * Make a proxy we did NOT spawn supervisable: record its pid in our pidfile so
 * every liveness check treats it as ours. Returns the adopted pid, or null.
 */
export function adoptRunningProxy(): number | null {
  const pid = findRunningProxyPid();
  if (pid === null) return null;
  writeHeadroomProxyPidfile(pid);
  return pid;
}

export function killHeadroomProxy(): void {
  const pid = readHeadroomProxyPidfile();
  if (pid !== null && isPidAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
      try {
        fs.rmSync(headroomProxyPidfilePath(), { force: true });
      } catch {
        /* best-effort */
      }
      return;
    } catch {
      /* died between probe and kill — fall through to the pattern kill */
    }
  }
  if (pid !== null) {
    try {
      fs.rmSync(headroomProxyPidfilePath(), { force: true });
    } catch {
      /* best-effort */
    }
  }
  // No usable pidfile. Prefer a TARGETED kill of a positively-identified
  // headroom proxy (/proc cmdline verified) over the blind pattern kill —
  // `pkill -f 'headroom.*proxy'` cannot tell "the wedged proxy I meant" from
  // "a healthy proxy someone else launched", and killing the latter is how a
  // working session gets broken (2026-08-13).
  const found = findRunningProxyPid();
  if (found !== null) {
    try {
      process.kill(found, 'SIGTERM');
      return;
    } catch {
      /* raced away — fall through */
    }
  }
  pkillFallback();
}
