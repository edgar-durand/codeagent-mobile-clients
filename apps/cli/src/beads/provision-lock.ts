// src/beads/provision-lock.ts
//
// One beads provisioning at a time per machine. Every session on a box or a
// warm codespace provisions beads against the SAME shared Dolt server, and bd
// serializes its own commands behind a machine-wide lock it only waits a few
// seconds for. Run concurrently, the losers fail and that session runs without
// beads: "bd init … failed: waiting for other bd commands to finish", "prefix
// DB … still unreachable after bootstrap + mint" (QA Box, 2026-10-02, three
// sessions provisioning at once). codeagent-w683 made the sessions start beads
// at the same moment (after the last agent startup), so they now take turns.
import fs from 'fs';
import os from 'os';
import path from 'path';

/** A holder older than this is presumed dead: a full provisioning (bd init +
 *  server start + DB self-heal + bd setup) stays well under it. */
const STALE_LOCK_MS = 5 * 60_000;

export interface ProvisionLockDeps {
  dir?: string;
  pid?: number;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** Stop waiting and run anyway after this long. Default 3 min. */
  timeoutMs?: number;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Atomically take the lock (mkdir), clearing it first when its holder is gone. */
function tryAcquire(lockDir: string, deps: ProvisionLockDeps): boolean {
  const pid = deps.pid ?? process.pid;
  try {
    fs.mkdirSync(path.dirname(lockDir), { recursive: true });
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'pid'), String(pid));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return true; // can't lock → don't block
  }
  let age: number;
  try {
    age = (deps.now ?? Date.now)() - fs.statSync(lockDir).mtimeMs;
  } catch {
    return tryAcquireOnce(lockDir, deps); // released meanwhile
  }
  let holder = NaN;
  try {
    holder = Number(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'));
  } catch {
    // A fresh holder writes its pid right after the mkdir; a lock that has
    // had no pid for 10 s belongs to a process that died in between.
    if (age <= 10_000) return false;
  }
  const alive = Number.isInteger(holder) && (deps.isAlive ?? pidIsAlive)(holder);
  if (alive && age <= STALE_LOCK_MS) return false;
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    return false;
  }
  return tryAcquireOnce(lockDir, deps);
}

/** One mkdir attempt, no stale handling (avoids recursing on a lost race). */
function tryAcquireOnce(lockDir: string, deps: ProvisionLockDeps): boolean {
  try {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'pid'), String(deps.pid ?? process.pid));
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `fn` while holding the machine-wide beads provisioning lock. Waits for
 * the current holder, but never longer than `timeoutMs` — after that `fn` runs
 * anyway, exactly as it did before the lock existed. Always releases.
 */
export async function withBeadsProvisionLock<T>(
  fn: () => Promise<T>,
  deps: ProvisionLockDeps = {},
): Promise<T> {
  const lockDir = path.join(deps.dir ?? path.join(os.homedir(), '.codeam'), 'beads-provision.lock');
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + (deps.timeoutMs ?? 180_000);
  let held = tryAcquire(lockDir, deps);
  while (!held && now() < deadline) {
    await sleep(500);
    held = tryAcquire(lockDir, deps);
  }
  try {
    return await fn();
  } finally {
    if (held) {
      try {
        const owner = Number(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'));
        if (owner === (deps.pid ?? process.pid)) fs.rmSync(lockDir, { recursive: true, force: true });
      } catch {
        // already gone
      }
    }
  }
}
