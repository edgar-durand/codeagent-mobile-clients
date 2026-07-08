// cursor-agent-binary.test.ts
//
// Unit coverage for the Windows stale-PATH fix (Georgy, Win 11, 2026-07):
// Cursor's installer drops `cursor-agent.exe` in `%LOCALAPPDATA%\cursor-agent\`
// and updates the *User* PATH, which our already-running CLI host never
// inherits — so a bare `cursor-agent` spawn ENOENTs even though it's
// installed. `resolveCursorAgentBinary` returns the deterministic absolute
// path so the spawn sidesteps PATH; `waitForCursorAgent` treats that
// known-location hit as ready instead of timing out.
//
// Pure, deps-injected — runs identically on every CI OS.

import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  resolveCursorAgentBinary,
  waitForCursorAgent,
} from '../../../src/agents/acp/agent-binary';

const WIN_LOCALAPPDATA = 'C:\\Users\\krest\\AppData\\Local';
const WIN_EXE = path.win32.join(WIN_LOCALAPPDATA, 'cursor-agent', 'cursor-agent.exe');

describe('resolveCursorAgentBinary — Windows', () => {
  it('returns the absolute %LOCALAPPDATA%\\cursor-agent\\cursor-agent.exe when present', () => {
    const got = resolveCursorAgentBinary({
      platform: 'win32',
      env: { LOCALAPPDATA: WIN_LOCALAPPDATA },
      existsSync: (p) => p === WIN_EXE,
    });
    expect(got).toBe(WIN_EXE);
  });

  it('returns null when the exe is not in the install dir (falls back to PATH)', () => {
    const got = resolveCursorAgentBinary({
      platform: 'win32',
      env: { LOCALAPPDATA: WIN_LOCALAPPDATA },
      existsSync: () => false,
    });
    expect(got).toBeNull();
  });

  it('returns null when LOCALAPPDATA is unset', () => {
    const got = resolveCursorAgentBinary({
      platform: 'win32',
      env: {},
      existsSync: () => true,
    });
    expect(got).toBeNull();
  });
});

describe('resolveCursorAgentBinary — Unix', () => {
  const home = '/home/user';
  const unixBin = path.posix.join(home, '.local', 'bin', 'cursor-agent');

  it('returns ~/.local/bin/cursor-agent when present', () => {
    const got = resolveCursorAgentBinary({
      platform: 'linux',
      homedir: home,
      existsSync: (p) => p === unixBin,
    });
    expect(got).toBe(unixBin);
  });

  it('returns null when absent', () => {
    const got = resolveCursorAgentBinary({
      platform: 'darwin',
      homedir: home,
      existsSync: () => false,
    });
    expect(got).toBeNull();
  });
});

describe('waitForCursorAgent', () => {
  it('is ready immediately from the known install location, without consulting PATH', async () => {
    let probed = false;
    const ready = await waitForCursorAgent({
      platform: 'win32',
      env: { LOCALAPPDATA: WIN_LOCALAPPDATA },
      existsSync: (p) => p === WIN_EXE,
      probe: () => {
        probed = true;
        return false;
      },
    });
    expect(ready).toBe(true);
    expect(probed).toBe(false); // resolver short-circuits the PATH probe
  });

  it('falls back to a PATH hit when not in the known location', async () => {
    const ready = await waitForCursorAgent({
      platform: 'linux',
      homedir: '/home/user',
      existsSync: () => false,
      probe: (cmd) => cmd === 'cursor-agent',
    });
    expect(ready).toBe(true);
  });

  it('times out to false when neither the install dir nor PATH has it', async () => {
    let t = 0;
    const ready = await waitForCursorAgent({
      platform: 'linux',
      homedir: '/home/user',
      existsSync: () => false,
      probe: () => false,
      timeoutMs: 5,
      pollMs: 1,
      now: () => t,
      sleep: async () => {
        t += 2;
      },
    });
    expect(ready).toBe(false);
  });
});
