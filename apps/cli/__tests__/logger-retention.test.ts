/**
 * 2026-09-27: per-pid rotation never removed the logs of dead processes; a
 * restart loop left 2,839 files / 12 GB in /root/.codeam on the fleet VPS.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pruneStaleLogs } from '../src/services/logger';

const DAY = 24 * 60 * 60 * 1000;
let dir: string;

function write(name: string, ageMs: number, bytes = 10): string {
  const f = path.join(dir, name);
  fs.writeFileSync(f, 'x'.repeat(bytes));
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(f, t, t);
  return f;
}

describe('pruneStaleLogs', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-logs-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('removes week-old logs of dead processes and keeps recent or live ones', () => {
    const old = write('debug-111.log', 8 * DAY);
    const oldArchive = write('debug-111.log.old', 8 * DAY);
    const recent = write('debug-222.log', 1 * DAY);
    const liveOld = write('debug-333.log', 30 * DAY);
    const other = write('host-agent.json', 30 * DAY);
    const removed = pruneStaleLogs(dir, Date.now(), (pid) => pid === 333);
    expect(removed).toBe(2);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(oldArchive)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(liveOld)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
  });

  it('enforces the 200 MB budget oldest-first, even for fresh logs', () => {
    const mb = 1024 * 1024;
    const newest = write('debug-1.log', 1000, 150 * mb);
    const middle = write('debug-2.log', 2000, 40 * mb);
    const oldest = write('debug-3.log', 3000, 40 * mb);
    pruneStaleLogs(dir, Date.now(), () => false);
    expect(fs.existsSync(newest)).toBe(true);
    expect(fs.existsSync(middle)).toBe(true);
    expect(fs.existsSync(oldest)).toBe(false);
  });
});
