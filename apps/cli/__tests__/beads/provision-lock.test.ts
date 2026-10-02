import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { withBeadsProvisionLock } from '../../src/beads/provision-lock';

// codeagent-w683: sessions on one machine provision beads one at a time, so
// they don't lose bd's own short machine-wide lock to each other.
describe('withBeadsProvisionLock', () => {
  let dir: string;
  const lockDir = (): string => path.join(dir, 'beads-provision.lock');
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w683-lock-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs fn, returns its value and releases the lock', async () => {
    const out = await withBeadsProvisionLock(async () => {
      expect(fs.readFileSync(path.join(lockDir(), 'pid'), 'utf8')).toBe('101 T1');
      return 'done';
    }, { dir, pid: 101, startTimeOf: () => 'T1' });
    expect(out).toBe('done');
    expect(fs.existsSync(lockDir())).toBe(false);
  });

  it('releases the lock when fn throws', async () => {
    await expect(
      withBeadsProvisionLock(async () => {
        throw new Error('bd init blew up');
      }, { dir, pid: 101 }),
    ).rejects.toThrow('bd init blew up');
    expect(fs.existsSync(lockDir())).toBe(false);
  });

  it('two sessions take turns — never both inside', async () => {
    let inside = 0;
    let maxInside = 0;
    const order: string[] = [];
    const run = (pid: number) =>
      withBeadsProvisionLock(
        async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          order.push(`start-${pid}`);
          await new Promise((r) => setTimeout(r, 30));
          order.push(`end-${pid}`);
          inside -= 1;
        },
        { dir, pid, isAlive: () => true, sleep: (ms) => new Promise((r) => setTimeout(r, ms / 50)) },
      );
    await Promise.all([run(101), run(202)]);
    expect(maxInside).toBe(1);
    expect(order[1]).toMatch(/^end-/);
  });

  it('takes over a lock whose holder is dead', async () => {
    fs.mkdirSync(lockDir());
    fs.writeFileSync(path.join(lockDir(), 'pid'), '999');
    let ran = false;
    await withBeadsProvisionLock(async () => {
      ran = true;
    }, { dir, pid: 101, isAlive: (p) => p !== 999, sleep: async () => undefined });
    expect(ran).toBe(true);
  });

  // A restarted container numbers processes from 1 again: the holder's pid now
  // belongs to another live CLI, but with a different start time.
  it('takes over a lock whose pid was recycled by a different process', async () => {
    fs.mkdirSync(lockDir());
    fs.writeFileSync(path.join(lockDir(), 'pid'), '22 5000');
    let ran = false;
    await withBeadsProvisionLock(async () => {
      ran = true;
    }, {
      dir,
      pid: 101,
      isAlive: () => true,
      startTimeOf: (p) => (p === 22 ? '9000' : '7000'),
      sleep: async () => undefined,
      timeoutMs: 0,
    });
    expect(ran).toBe(true);
    expect(fs.existsSync(lockDir())).toBe(false);
  });

  it('still waits on a live holder whose start time matches', async () => {
    fs.mkdirSync(lockDir());
    fs.writeFileSync(path.join(lockDir(), 'pid'), '22 5000');
    let t = 0;
    await withBeadsProvisionLock(async () => undefined, {
      dir,
      pid: 101,
      isAlive: () => true,
      startTimeOf: () => '5000',
      timeoutMs: 1_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(t).toBeGreaterThanOrEqual(1_000);
    expect(fs.readFileSync(path.join(lockDir(), 'pid'), 'utf8')).toBe('22 5000');
  });

  it('runs anyway after the timeout when the holder never lets go, and leaves its lock alone', async () => {
    fs.mkdirSync(lockDir());
    fs.writeFileSync(path.join(lockDir(), 'pid'), '999');
    let t = 0;
    let ran = false;
    await withBeadsProvisionLock(async () => {
      ran = true;
    }, {
      dir,
      pid: 101,
      isAlive: () => true,
      timeoutMs: 2_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(ran).toBe(true);
    expect(fs.readFileSync(path.join(lockDir(), 'pid'), 'utf8')).toBe('999');
  });
});
