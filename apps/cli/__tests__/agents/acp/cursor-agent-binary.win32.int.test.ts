// cursor-agent-binary.win32.int.test.ts
//
// REAL-Windows integration test for the 2026-07 `cursor-agent` ENOENT fix
// (Georgy, Win 11). Unlike the cross-platform unit tests — which inject
// `platform`/`existsSync` — this exercises the ACTUAL win32 branch with the
// REAL `process.platform === 'win32'`, REAL `path` (== path.win32), and REAL
// `fs`, against a faithful reproduction of what Cursor's installer
// (`cursor.com/install?win32=true`) lays down:
//
//     %LOCALAPPDATA%\cursor-agent\cursor-agent.exe
//
// It is the STEP-8 gate a non-Windows host (incl. Docker on macOS/Linux)
// physically cannot reach: only a real Windows kernel resolves `\`-separated
// paths. `describe.skipIf` makes it a no-op on macOS/Linux CI cells and
// developer laptops; it runs for real in the `cli` job's `windows-latest`
// matrix cell.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveCursorAgentBinary, waitForCursorAgent } from '../../../src/agents/acp/agent-binary';

describe.skipIf(process.platform !== 'win32')('cursor-agent resolution on real Windows', () => {
  let localAppData: string;

  beforeEach(() => {
    // A throwaway %LOCALAPPDATA% so we never touch the runner's real one.
    localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'localappdata-'));
  });

  afterEach(() => {
    fs.rmSync(localAppData, { recursive: true, force: true });
  });

  /** Reproduce the installer layout; returns the .exe path it creates. */
  function installCursorAgent(): string {
    const dir = path.join(localAppData, 'cursor-agent');
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, 'cursor-agent.exe');
    fs.writeFileSync(exe, 'MZ'); // real file at the installer's location
    return exe;
  }

  it('resolves the absolute %LOCALAPPDATA%\\cursor-agent\\cursor-agent.exe (real platform + fs)', () => {
    const exe = installCursorAgent();
    // No platform/existsSync injection — only redirect LOCALAPPDATA to temp.
    const got = resolveCursorAgentBinary({ env: { LOCALAPPDATA: localAppData } });
    expect(got).toBe(exe);
    expect(path.isAbsolute(got!)).toBe(true);
    expect(fs.existsSync(got!)).toBe(true);
  });

  it('waitForCursorAgent is immediately ready from the known install location', async () => {
    installCursorAgent();
    const ready = await waitForCursorAgent({
      env: { LOCALAPPDATA: localAppData },
      probe: () => false, // prove readiness comes from the resolver, not PATH
    });
    expect(ready).toBe(true);
  });

  it('returns null when cursor-agent is not installed (safe fallback to bare-name PATH)', () => {
    const got = resolveCursorAgentBinary({ env: { LOCALAPPDATA: localAppData } });
    expect(got).toBeNull();
  });
});
