import { describe, it, expect, afterEach } from 'vitest';

/**
 * Logger rotation + JSON + XDG-aware path coverage (#66).
 *
 * The logger reads env vars at module-eval time for `LOG_DIR`,
 * `jsonMode`, etc., so each scenario sets the env BEFORE the
 * dynamic `import()` to get a fresh module instance with the right
 * defaults. We can't use vitest's `vi.resetModules()` + `require()`
 * here cleanly because the logger relies on top-level constants —
 * one fresh import per case is the clean path.
 */

import { resolveLogDir } from '../../src/services/logger';

describe('logger path resolution', () => {
  const ORIG_PLATFORM = process.platform;
  const ORIG_XDG = process.env.XDG_STATE_HOME;
  const ORIG_LOCAL = process.env.LOCALAPPDATA;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM });
    if (ORIG_XDG !== undefined) process.env.XDG_STATE_HOME = ORIG_XDG;
    else delete process.env.XDG_STATE_HOME;
    if (ORIG_LOCAL !== undefined) process.env.LOCALAPPDATA = ORIG_LOCAL;
    else delete process.env.LOCALAPPDATA;
  });

  it('honours XDG_STATE_HOME on Linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.XDG_STATE_HOME = '/tmp/xdg-state';
    // path.join uses the HOST's separator, so on a Windows runner the
    // returned dir is `\tmp\xdg-state\codeam`. Normalize before asserting
    // — the invariant is "XDG_STATE_HOME root + /codeam segment".
    const dir = resolveLogDir().replace(/\\/g, '/');
    expect(dir).toBe('/tmp/xdg-state/codeam');
  });

  it('honours %LOCALAPPDATA% on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.LOCALAPPDATA = 'C:\\Users\\x\\AppData\\Local';
    const dir = resolveLogDir();
    // path.join uses the HOST's separator (we can't stub `path.sep`
    // alongside process.platform without monkeypatching node:path).
    // The semantic invariant is: directory ends with `codeam/Logs`
    // (or the Windows backslash equivalent on a real Windows host).
    expect(dir.startsWith('C:\\Users\\x\\AppData\\Local')).toBe(true);
    expect(dir.replace(/\\/g, '/').endsWith('codeam/Logs')).toBe(true);
  });

  it('falls back to ~/.codeam on macOS + Linux-without-XDG', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    delete process.env.XDG_STATE_HOME;
    expect(resolveLogDir().endsWith('.codeam')).toBe(true);

    Object.defineProperty(process, 'platform', { value: 'linux' });
    delete process.env.XDG_STATE_HOME;
    expect(resolveLogDir().endsWith('.codeam')).toBe(true);
  });
});

describe('logger rotation invariants', () => {
  it('exposes MAX_LOG_BYTES = 5 MB (regression anchor)', async () => {
    const mod = await import('../../src/services/logger');
    expect(mod._logHelpers.getMaxLogBytes()).toBe(5 * 1024 * 1024);
  });

  it('debug file path is per-pid', async () => {
    const mod = await import('../../src/services/logger');
    const p = mod._logHelpers.getDebugFilePath();
    expect(p).toContain(String(process.pid));
    expect(p.endsWith('.log')).toBe(true);
  });
});

/**
 * codeagent-bcvb: in a container every boot reuses the same pids (the Box
 * host-agent is always pid 1), so the first write of a new process used to
 * REPLACE the previous boot's `debug-<pid>.log` — erasing the only record of
 * why a session was not resumed after a wake. The previous file is archived
 * into the bounded chain instead.
 */
describe('logger — a previous process with the same pid', () => {
  it('archives the earlier log to .old instead of overwriting it', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { vi } = await import('vitest');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-log-'));
    const origPlatform = process.platform;
    const origXdg = process.env.XDG_STATE_HOME;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.XDG_STATE_HOME = dir;
    try {
      vi.resetModules();
      const mod = await import('../../src/services/logger');
      const file = mod._logHelpers.getDebugFilePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'previous boot: resume: 2 session(s) resumed\n');
      mod.log.info('test', 'new boot');
      expect(fs.readFileSync(`${file}.old`, 'utf8')).toContain('previous boot');
      const current = fs.readFileSync(file, 'utf8');
      expect(current).toContain('new boot');
      expect(current).not.toContain('previous boot');
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
      if (origXdg !== undefined) process.env.XDG_STATE_HOME = origXdg;
      else delete process.env.XDG_STATE_HOME;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
