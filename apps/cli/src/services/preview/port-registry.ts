/**
 * Persistent preview-port ownership registry.
 *
 * WHY (Rafael's 2026-07-14 feedback, web-app preview on our app): the
 * in-memory `activePreviews` map is the ONLY record that a dev server on
 * port N belongs to us — and it dies with the CLI process. When the relay
 * is restarted (`kickCodeam` does `pkill -f codeam`, which does NOT match
 * the detached `next`/`vite` dev-server process group, so it survives) or
 * the CLI is hard-killed (SIGKILL / codespace force-stop → the graceful
 * sigintHandler never runs), the dev server is orphaned WITH the port
 * still bound. The fresh CLI then sees a busy port it has no memory of,
 * classifies it as a FOREIGN process, and dead-ends with "port already in
 * use" — forcing the user to ask the agent to kill it. Rafael: "se queda
 * mareado y luego me dice que el puerto ya está siendo usado … tengo que
 * decirle manualmente al agente que lo cierre".
 *
 * This registry persists `{ port → { pgid, sessionId, ts } }` to
 * `~/.codeam/preview-ports.json` so a fresh CLI can recognize its OWN
 * leaked dev server and reclaim it automatically — provably safe because
 * we only ever SIGTERM a process GROUP we recorded ourselves as having
 * spawned. A genuinely foreign process (never recorded here) is left
 * untouched and still surfaces the actionable error.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { log } from '../logger';

interface PortOwner {
  /** Process-group id of the dev server we spawned (detached → its own
   *  group leader; `-pgid` signals the whole worker tree). */
  pgid: number;
  sessionId: string;
  ts: number;
}

type Registry = Record<string, PortOwner>;

function registryPath(): string {
  return path.join(os.homedir(), '.codeam', 'preview-ports.json');
}

function readRegistry(): Registry {
  try {
    const raw = fs.readFileSync(registryPath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as Registry;
  } catch {
    /* missing / malformed — treat as empty */
  }
  return {};
}

function writeRegistry(reg: Registry): void {
  try {
    const file = registryPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(reg), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    // Best-effort: a lost record just means the next restart falls back to
    // the actionable "foreign port" error instead of auto-reclaiming.
    log.warn('preview', `port-registry write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Record that we own `port` via the dev server whose PID is `devPid`
 *  (its own process-group leader on POSIX). No-op with a null pid. */
export function recordPreviewPort(port: number, devPid: number | undefined, sessionId: string, now: number): void {
  if (devPid == null) return;
  const reg = readRegistry();
  reg[String(port)] = { pgid: devPid, sessionId, ts: now };
  writeRegistry(reg);
}

/** Drop the ownership record for `port` (called on a clean teardown). */
export function forgetPreviewPort(port: number): void {
  const reg = readRegistry();
  if (reg[String(port)] === undefined) return;
  delete reg[String(port)];
  writeRegistry(reg);
}

/** Best-effort "is this process group still alive?" — `kill(pid, 0)`
 *  throws ESRCH when it's gone, EPERM when it exists but we can't signal
 *  it (still counts as alive). POSIX probes the whole group via the
 *  negative pid; Windows has no process groups, so it probes the leader
 *  pid directly (signal 0 tests existence on Windows too). */
function groupAlive(pgid: number): boolean {
  const probe = process.platform === 'win32' ? pgid : -pgid;
  try {
    process.kill(probe, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Terminate the recorded dev-server tree. POSIX: SIGTERM the whole
 *  process group (`-pgid`) then a SIGKILL backstop for a server that
 *  ignores SIGTERM. Windows: no process groups, so `taskkill /F /T` force-
 *  kills the leader AND its child tree (the dev server + its workers) in
 *  one shot. Best-effort on both — a lost race just means the port frees a
 *  beat later. */
function killGroup(pgid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pgid)], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch {
    /* raced to exit between the alive check and the signal */
  }
  // SIGKILL backstop for a dev server that ignores SIGTERM.
  try {
    setTimeout(() => {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, 300).unref?.();
  } catch {
    /* setTimeout unref unsupported — harmless */
  }
}

/**
 * If `port` is recorded as OURS and that process group is still alive,
 * SIGTERM it (then SIGKILL the stragglers) and return `true` — the caller
 * then waits for the OS to release the port and re-spawns. Returns `false`
 * when the port was never ours (a foreign squatter → leave it alone) or
 * the recorded group is already dead (stale record → clean it up).
 *
 * Cross-platform: POSIX signals the detached process group; Windows has no
 * process groups, so `killGroup` uses `taskkill /F /T` to force-kill the
 * recorded leader pid AND its child tree. Either way we only ever kill a
 * tree WE recorded ourselves as having spawned.
 */
export function reclaimOwnOrphanPort(port: number): boolean {
  const reg = readRegistry();
  const owner = reg[String(port)];
  if (!owner) return false;

  if (!groupAlive(owner.pgid)) {
    // Stale record (the process died on its own) — clean up, report "not
    // reclaimed by us" so the caller re-checks the live port state.
    delete reg[String(port)];
    writeRegistry(reg);
    return false;
  }

  log.info(
    'preview',
    `reclaiming OWN orphaned preview on port ${port} (pgid=${owner.pgid}, session=${owner.sessionId}) after a CLI restart`,
  );
  killGroup(owner.pgid);
  delete reg[String(port)];
  writeRegistry(reg);
  return true;
}
