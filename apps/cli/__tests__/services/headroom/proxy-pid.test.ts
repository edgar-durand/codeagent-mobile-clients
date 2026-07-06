/**
 * Unit tests for apps/cli/src/services/headroom/proxy-pid.ts.
 *
 * The pidfile helper replaces the blind `pkill -TERM -f 'headroom.*proxy'`
 * pattern kill: spawn sites record the detached proxy's pid, kill sites
 * SIGTERM that exact pid and only fall back to the pkill pattern when no
 * live recorded pid exists.
 *
 * Conventions: real fs against a tmpdir HOME (same HOME/USERPROFILE override
 * as codex/gemini local-token tests), `vi.mock('node:child_process')` for the
 * pkill fallback, `vi.spyOn(process, 'kill')` for the targeted kill.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => ({
    once: vi.fn(),
    unref: vi.fn(),
  })),
}));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import {
  headroomProxyPidfilePath,
  killHeadroomProxy,
  readHeadroomProxyPidfile,
  writeHeadroomProxyPidfile,
} from '../../../src/services/headroom/proxy-pid';

let tmpHome: string;
let origHome: string | undefined;
let origUserProfile: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), 'proxy-pid-test-'));
  origHome = process.env.HOME;
  origUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  spawnMock.mockClear();
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = origUserProfile;
  rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('headroomProxyPidfilePath', () => {
  it('lives next to ~/.codeam/headroom-config.json', () => {
    expect(headroomProxyPidfilePath()).toBe(path.join(tmpHome, '.codeam', 'headroom-proxy.pid'));
  });
});

describe('writeHeadroomProxyPidfile / readHeadroomProxyPidfile', () => {
  it('round-trips a pid (creating ~/.codeam on demand)', () => {
    writeHeadroomProxyPidfile(12345);
    expect(readFileSync(headroomProxyPidfilePath(), 'utf8')).toBe('12345\n');
    expect(readHeadroomProxyPidfile()).toBe(12345);
  });

  it('skips writing when pid is undefined (failed spawn)', () => {
    writeHeadroomProxyPidfile(undefined);
    expect(existsSync(headroomProxyPidfilePath())).toBe(false);
  });

  it('returns null when the pidfile is absent', () => {
    expect(readHeadroomProxyPidfile()).toBeNull();
  });

  it('returns null for unparseable or non-positive content', () => {
    mkdirSync(path.dirname(headroomProxyPidfilePath()), { recursive: true });
    writeFileSync(headroomProxyPidfilePath(), 'not-a-pid\n');
    expect(readHeadroomProxyPidfile()).toBeNull();
    writeFileSync(headroomProxyPidfilePath(), '-4\n');
    expect(readHeadroomProxyPidfile()).toBeNull();
  });
});

describe('killHeadroomProxy', () => {
  it('SIGTERMs the recorded pid and removes the pidfile — no pkill', () => {
    writeHeadroomProxyPidfile(4242);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    killHeadroomProxy();

    expect(killSpy).toHaveBeenCalledWith(4242, 0);          // liveness probe
    expect(killSpy).toHaveBeenCalledWith(4242, 'SIGTERM');  // targeted kill
    expect(existsSync(headroomProxyPidfilePath())).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('falls back to the pkill pattern when the recorded pid is dead (stale pidfile removed)', () => {
    writeHeadroomProxyPidfile(4242);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('kill ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });

    killHeadroomProxy();

    expect(killSpy).toHaveBeenCalledWith(4242, 0);
    expect(killSpy).not.toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(existsSync(headroomProxyPidfilePath())).toBe(false);
    expect(spawnMock).toHaveBeenCalledWith('pkill', ['-TERM', '-f', 'headroom.*proxy'], {
      detached: true,
      stdio: 'ignore',
    });
  });

  it('falls back to the pkill pattern when no pidfile exists (older-CLI proxy)', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    killHeadroomProxy();

    expect(killSpy).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledWith('pkill', ['-TERM', '-f', 'headroom.*proxy'], {
      detached: true,
      stdio: 'ignore',
    });
  });

  it('never throws when the pkill fallback spawn itself throws synchronously', () => {
    spawnMock.mockImplementationOnce(() => {
      throw new Error('spawn EPERM');
    });
    expect(() => killHeadroomProxy()).not.toThrow();
  });
});
