/**
 * Single-flight spawn lock for `spawnHeadroomProxy`.
 *
 * Two relay supervisors on one box (or a supervisor racing a deliberate
 * relaunch) must never both launch `headroom proxy --port 8787` at once — the
 * second EADDRINUSEs and the failed /livez re-triggers the loop. The lock is a
 * TTL'd O_EXCL file next to the pidfile: the first spawner takes it, a
 * concurrent non-force spawner backs off; deliberate `force` callers proceed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

// Spawn is the only real side effect we don't want in a unit test.
const spawnMock = vi.fn(() => ({
  pid: 4242,
  once: vi.fn(),
  unref: vi.fn(),
}));
vi.mock('child_process', () => ({ spawn: () => spawnMock() }));

import { spawnHeadroomProxy } from '../../src/services/headroom/proxy-process';
import { headroomProxySpawnLockPath } from '../../src/services/headroom/proxy-pid';

const LOGGING = {
  tag: 'test',
  spawnErrorMsg: (d: string) => d,
  failureMsg: (d: string) => d,
};

function rmLock() {
  try {
    fs.rmSync(headroomProxySpawnLockPath(), { force: true });
  } catch {
    /* ignore */
  }
}

describe('spawnHeadroomProxy single-flight lock', () => {
  beforeEach(() => {
    spawnMock.mockClear();
    rmLock();
  });
  afterEach(rmLock);

  it('spawns and creates the lock on the first call', () => {
    spawnHeadroomProxy(LOGGING);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(headroomProxySpawnLockPath())).toBe(true);
  });

  it('a second concurrent (non-force) call backs off — only one spawn', () => {
    spawnHeadroomProxy(LOGGING);
    spawnHeadroomProxy(LOGGING); // lock held & fresh → skip
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('a force call spawns even when the lock is held (deliberate relaunch)', () => {
    spawnHeadroomProxy(LOGGING); // takes the lock
    spawnHeadroomProxy(LOGGING, { force: true }); // must win anyway
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('steals a stale lock (older than the TTL) and spawns', () => {
    // Simulate a lock left by a process that died mid-spawn: write it, then
    // back-date its mtime well beyond the TTL.
    const lock = headroomProxySpawnLockPath();
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, '999999\n');
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lock, old, old);

    spawnHeadroomProxy(LOGGING);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('writes the lock under ~/.codeam', () => {
    expect(headroomProxySpawnLockPath()).toBe(
      path.join(os.homedir(), '.codeam', 'headroom-proxy.spawn.lock'),
    );
  });
});
