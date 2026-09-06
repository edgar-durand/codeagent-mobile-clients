import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import {
  _lockHelpers,
  acquireDaemonLock,
  acquireSingletonLock,
  daemonLockPath,
  isLiveCodeam,
  readLockRecord,
} from '../src/commands/pair-auto';

/**
 * 2026-09-05 warm-codespace incident (dev2.brico, codespace 9pv7gjqw556c9pj7):
 * the host-agent woke and spawned the resume child for the paired session, the
 * child hit `acquireDaemonLock(session.id)`, found the PREVIOUS boot's lock
 * (`daemon-<session>.lock` = 587, the 09-04 child) and asked `isLiveCodeam(587)`.
 * On the new boot pid 587 was a THREAD of the freshly started host-agent itself
 * (host pid 575 + ~13 node threads): `kill(587, 0)` succeeds on a thread id and
 * `/proc/587/cmdline` is the thread-group leader's — `node … codeam host-agent`
 * — so the check said "live codeam" and the child exit(0)-deferred to a phantom.
 * Exit 0 is silent in the supervisor, so the session sat HOST_OFFLINE for 40
 * minutes until the user deleted it.
 *
 * These tests drive the liveness check through a FAKE procfs root so the
 * mechanism is reproducible on macOS/CI: a real live pid (a `sleep` child) whose
 * /proc entry we author.
 */

let tmpHome: string;
let fakeProc: string;
let origHome: string | undefined;
let origUserProfile: string | undefined;
let liveChild: ChildProcess | undefined;

const SESSION_ID = 'sess-reused-pid';
const HOST_AGENT_CMDLINE = '/usr/local/bin/node\0/usr/local/bin/codeam\0host-agent\0';

/** Author a /proc/<pid> entry: cmdline + status (Tgid) + stat (starttime field 22). */
function writeProcEntry(
  pid: number,
  opts: { cmdline: string; tgid?: number; startTicks?: string },
): void {
  const dir = path.join(fakeProc, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cmdline'), opts.cmdline);
  fs.writeFileSync(path.join(dir, 'status'), `Name:\tnode\nTgid:\t${opts.tgid ?? pid}\nPid:\t${pid}\n`);
  // Real /proc/<pid>/stat shape: "pid (comm) S ppid ..." — comm may contain
  // spaces/parens, which is why the parser anchors on the LAST ')'. Field 22
  // (starttime) is the 20th token after the state.
  const after = ['S', '1', '1', '1', '0', '-1', '4194560', '0', '0', '0', '0', '0', '0', '0', '0', '20', '0', '13', '0', opts.startTicks ?? '4321', '0'];
  fs.writeFileSync(path.join(dir, 'stat'), `${pid} (node) ${after.join(' ')}\n`);
}

function writeBootId(id: string): void {
  const dir = path.join(fakeProc, 'sys', 'kernel', 'random');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'boot_id'), `${id}\n`);
}

function spawnLivePid(): number {
  liveChild = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  liveChild.unref();
  return liveChild.pid!;
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-reused-pid-'));
  fakeProc = path.join(tmpHome, 'proc');
  fs.mkdirSync(fakeProc, { recursive: true });
  origHome = process.env.HOME;
  origUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  _lockHelpers.setProcRootForTests(fakeProc);
  writeBootId('boot-A');
});

afterEach(() => {
  _lockHelpers.setProcRootForTests(undefined);
  process.env.HOME = origHome;
  process.env.USERPROFILE = origUserProfile;
  if (liveChild?.pid) {
    try { process.kill(liveChild.pid, 'SIGKILL'); } catch { /* gone */ }
  }
  liveChild = undefined;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('isLiveCodeam — a reused pid that is a THREAD of another codeam process', () => {
  it('returns false when /proc/<pid>/status Tgid differs from the pid (thread id, not a process)', () => {
    const tid = spawnLivePid();
    // The thread's cmdline is its group leader's — the host-agent — so the old
    // cmdline.includes('codeam') check alone says "live".
    writeProcEntry(tid, { cmdline: HOST_AGENT_CMDLINE, tgid: tid - 12 });
    expect(isLiveCodeam(tid)).toBe(false);
  });

  it('still returns true for a real live codeam PROCESS (Tgid === pid)', () => {
    const pid = spawnLivePid();
    writeProcEntry(pid, { cmdline: HOST_AGENT_CMDLINE });
    expect(isLiveCodeam(pid)).toBe(true);
  });
});

describe('acquireDaemonLock — stale lock from a previous boot whose pid was reused', () => {
  it('reclaims a legacy pid-only lock when the pid is now a thread of the host-agent (the 09-05 incident)', () => {
    const reused = spawnLivePid();
    writeProcEntry(reused, { cmdline: HOST_AGENT_CMDLINE, tgid: reused - 12 });
    const lockPath = daemonLockPath(SESSION_ID);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, String(reused)); // what a pre-fix CLI wrote on the previous boot

    expect(acquireDaemonLock(SESSION_ID)).toBe(true);
    expect(readLockRecord(lockPath)?.pid).toBe(process.pid);
  });

  it('reclaims a lock recorded under a DIFFERENT kernel boot id even if the pid is a live codeam process', () => {
    const reused = spawnLivePid();
    writeProcEntry(reused, { cmdline: HOST_AGENT_CMDLINE, startTicks: '100' });
    const lockPath = daemonLockPath(SESSION_ID);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, `${reused}\nstart=100 boot=boot-PREVIOUS\n`);

    expect(acquireDaemonLock(SESSION_ID)).toBe(true);
    expect(readLockRecord(lockPath)?.pid).toBe(process.pid);
  });

  it('reclaims a lock whose recorded process start time no longer matches the pid (same boot, pid reused)', () => {
    const reused = spawnLivePid();
    writeProcEntry(reused, { cmdline: HOST_AGENT_CMDLINE, startTicks: '99999' });
    const lockPath = daemonLockPath(SESSION_ID);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, `${reused}\nstart=100 boot=boot-A\n`);

    expect(acquireDaemonLock(SESSION_ID)).toBe(true);
    expect(readLockRecord(lockPath)?.pid).toBe(process.pid);
  });

  it('DEFERS (returns false) to a genuinely live holder: same boot, same start time, real codeam process', () => {
    const holder = spawnLivePid();
    writeProcEntry(holder, { cmdline: HOST_AGENT_CMDLINE, startTicks: '100' });
    const lockPath = daemonLockPath(SESSION_ID);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, `${holder}\nstart=100 boot=boot-A\n`);

    expect(acquireDaemonLock(SESSION_ID)).toBe(false);
    expect(readLockRecord(lockPath)?.pid).toBe(holder);
  });

  it('records the holder start time + boot id alongside the pid so the NEXT boot can tell a reused pid apart', () => {
    writeProcEntry(process.pid, { cmdline: HOST_AGENT_CMDLINE, startTicks: '777' });
    expect(acquireDaemonLock(SESSION_ID)).toBe(true);
    const rec = readLockRecord(daemonLockPath(SESSION_ID));
    expect(rec).toEqual({ pid: process.pid, start: '777', boot: 'boot-A' });
    // Legacy readers (`Number(content.trim())`) get NaN → treat as stale → reclaim;
    // the first line stays the bare pid for humans (`head -1`).
    expect(fs.readFileSync(daemonLockPath(SESSION_ID), 'utf8').split('\n')[0]).toBe(String(process.pid));
  });
});

describe('acquireSingletonLock — same reused-pid guard for the box-wide pair-auto lock', () => {
  it('reclaims a legacy pid-only lock when the pid is now a thread of another codeam process', () => {
    const reused = spawnLivePid();
    writeProcEntry(reused, { cmdline: HOST_AGENT_CMDLINE, tgid: reused - 12 });
    const lockPath = path.join(tmpHome, '.codeam', 'pair-auto.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, String(reused));

    expect(acquireSingletonLock()).toBe(true);
    expect(readLockRecord(lockPath)?.pid).toBe(process.pid);
  });
});
