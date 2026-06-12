import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { acquireSingletonLock, isLivePairAuto } from '../src/commands/pair-auto';

// HOME + USERPROFILE both redirected so `os.homedir()` (and thus the lock
// path) points at a throwaway dir on Linux/macOS + Windows CI shards.
let tmpHome: string;
let origHome: string | undefined;
let origUserProfile: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-lock-'));
  origHome = process.env.HOME;
  origUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  process.env.HOME = origHome;
  process.env.USERPROFILE = origUserProfile;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const lockFile = () => path.join(tmpHome, '.codeam', 'pair-auto.lock');
const DEAD_PID = 2 ** 31 - 1; // 2147483647 — beyond any real PID, always dead

describe('isLivePairAuto', () => {
  it('is false for dead / invalid pids and never defers to ourselves', () => {
    expect(isLivePairAuto(DEAD_PID)).toBe(false);
    expect(isLivePairAuto(0)).toBe(false);
    expect(isLivePairAuto(-1)).toBe(false);
    // Excluding our own pid is what lets a fresh pair-auto take the lock.
    expect(isLivePairAuto(process.pid)).toBe(false);
  });
});

describe('acquireSingletonLock', () => {
  it('acquires when no lock exists and records our pid', () => {
    expect(acquireSingletonLock()).toBe(true);
    expect(Number(fs.readFileSync(lockFile(), 'utf8'))).toBe(process.pid);
  });

  it('reclaims a stale lock left by a dead process', () => {
    fs.mkdirSync(path.dirname(lockFile()), { recursive: true });
    fs.writeFileSync(lockFile(), String(DEAD_PID));
    expect(acquireSingletonLock()).toBe(true);
    expect(Number(fs.readFileSync(lockFile(), 'utf8'))).toBe(process.pid);
  });
});
