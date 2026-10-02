// src/commands/start/agent-startup-marks.ts
//
// One file per CLI process whose agent is still starting (spawn → ACP
// handshake), under ~/.codeam/agent-startups/<pid>. Beads provisioning waits
// until there are none, so it never competes with ANY session's agent startup
// on the same machine (codeagent-w683).
//
// ⚠️ Per-session waiting was not enough. On a 1-vCPU Box that wakes with five
// sessions, the sessions whose handshake finished first started beads (`bd
// init` + the `dolt sql-server` start), and the last session to spawn — the
// brand-new scratch session — took 29.6 s in `session/new` while the first
// took 6 s.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ownerIsAlive, ownerRecord, type ProcessIdentityDeps } from '../../lib/process-identity';

/** A mark older than this is ignored: no handshake takes this long (the
 *  runner gives up on `session/new` at 120 s), so its owner died or its pid
 *  was recycled. */
const STALE_MARK_MS = 180_000;

export interface StartupMarkDeps extends ProcessIdentityDeps {
  dir?: string;
  pid?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function marksDir(deps: StartupMarkDeps): string {
  return deps.dir ?? path.join(os.homedir(), '.codeam', 'agent-startups');
}

/**
 * Mark this process's agent as starting. Returns the release function, which
 * is idempotent and never throws. Best-effort: if the mark can't be written,
 * the release is a no-op and nothing waits on it.
 */
export function markAgentStarting(deps: StartupMarkDeps = {}): () => void {
  const pid = deps.pid ?? process.pid;
  const file = path.join(marksDir(deps), String(pid));
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ownerRecord(pid, deps));
  } catch {
    return () => undefined;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // best-effort
    }
  };
}

/** Pids of OTHER processes whose agent is still starting. Removes marks whose
 *  owner is gone. */
export function otherAgentsStarting(deps: StartupMarkDeps = {}): number[] {
  const dir = marksDir(deps);
  const self = deps.pid ?? process.pid;
  const now = (deps.now ?? Date.now)();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const live: number[] = [];
  for (const name of names) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0 || pid === self) continue;
    const file = path.join(dir, name);
    let record = '';
    try {
      record = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // Marks written before the start time was recorded hold just ''.
    let stale = !ownerIsAlive(record.trim() || String(pid), deps);
    if (!stale) {
      try {
        stale = now - fs.statSync(file).mtimeMs > STALE_MARK_MS;
      } catch {
        continue;
      }
    }
    if (stale) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // best-effort
      }
      continue;
    }
    live.push(pid);
  }
  return live;
}

/** Resolve once no other agent on this machine is starting, or after
 *  `timeoutMs`. Never rejects. */
export async function waitForNoAgentStarting(
  opts: StartupMarkDeps & { timeoutMs: number; pollMs?: number },
): Promise<void> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + opts.timeoutMs;
  while (otherAgentsStarting(opts).length > 0 && now() < deadline) {
    await sleep(opts.pollMs ?? 500);
  }
}
