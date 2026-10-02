// src/lib/process-identity.ts
//
// "Is the process that wrote this file still running?" A pid alone can't
// answer that inside a container: a restarted box numbers its processes from 1
// again, so the pid of a CLI that died in the previous run usually belongs to
// a DIFFERENT live CLI now. (QA Box, 2026-10-02: the beads provisioning lock
// written by pid 22 before a `docker stop` looked held by the new pid 22 after
// the restart, and every session's beads waited out the 3 min timeout.)
//
// So the owner records its pid AND its start time (Linux `/proc/<pid>/stat`
// field 22, clock ticks since boot). A recycled pid has a different start
// time. Where /proc isn't available the start time is '' and the check falls
// back to the pid alone, as before.
import fs from 'fs';

export interface ProcessIdentityDeps {
  isAlive?: (pid: number) => boolean;
  startTimeOf?: (pid: number) => string;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the pid exists but belongs to someone else, so it is alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Start time of `pid` from /proc, or '' when unavailable. */
export function procStartTime(pid: number): string {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // `comm` (field 2) may contain spaces and parens; fields resume after the
    // LAST ')'. starttime is field 22 overall = index 19 after `comm`.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return rest[19] ?? '';
  } catch {
    return '';
  }
}

/** What an owner writes: `<pid> <starttime>`. */
export function ownerRecord(pid: number, deps: ProcessIdentityDeps = {}): string {
  return `${pid} ${(deps.startTimeOf ?? procStartTime)(pid)}`.trim();
}

/** True when the process that wrote `record` is still the one running. */
export function ownerIsAlive(record: string, deps: ProcessIdentityDeps = {}): boolean {
  const [pidText, recordedStart = ''] = record.trim().split(/\s+/);
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (!(deps.isAlive ?? pidIsAlive)(pid)) return false;
  if (!recordedStart) return true;
  const now = (deps.startTimeOf ?? procStartTime)(pid);
  return now === '' || now === recordedStart;
}
