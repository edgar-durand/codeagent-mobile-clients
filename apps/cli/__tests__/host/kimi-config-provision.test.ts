import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock spawnSync so we can assert HOW `kimi login` is invoked (the config.toml
// provisioning), and the OS strategy so we can force Windows-style wrapping.
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn(() => ({ status: 0 })) };
});
vi.mock('../../src/os', async (orig) => {
  const actual = await orig<typeof import('../../src/os')>();
  return {
    ...actual,
    // Windows-style OsStrategy: findInPath resolves a `.cmd`, buildLaunch wraps
    // it with cmd.exe /c (a bare spawnSync of a .cmd EINVALs on Windows).
    createOsStrategy: () => ({
      id: 'win32',
      findInPath: () => 'C:\\Users\\U\\.kimi-code\\bin\\kimi.cmd',
      buildLaunch: (cmd: string, args: string[]) => ({ cmd: 'cmd.exe', args: ['/c', cmd, ...args] }),
    }),
  };
});

import { spawnSync } from 'node:child_process';
import { provisionAgentCredentials } from '../../src/commands/host/agent-provisioning';

const spawnSyncMock = spawnSync as unknown as ReturnType<typeof vi.fn>;

let tmpHome: string;
beforeEach(() => {
  spawnSyncMock.mockClear();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-cfg-'));
});
afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('kimi oauth_token provisioning — config.toml via `kimi login` (Windows-safe)', () => {
  it('runs `kimi login` through buildLaunch (wrapped) with stdio:ignore — never a bare spawn or </dev/null redirect', () => {
    provisionAgentCredentials('kimi', { kind: 'oauth_token', value: '{"access_token":"x"}' }, tmpHome);

    // The credential blob is still written to both locations.
    expect(fs.existsSync(path.join(tmpHome, '.kimi', 'credentials', 'kimi-code.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.kimi-code', 'credentials', 'kimi-code.json'))).toBe(true);

    // `kimi login` was invoked exactly once, via the OS-strategy WRAPPED command
    // (cmd.exe /c … kimi.cmd login) — NOT a bare `spawnSync('kimi'|'*.cmd', …)`
    // which EINVALs on Windows.
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnSyncMock.mock.calls[0];
    expect(cmd).toBe('cmd.exe');
    expect(args).toEqual(['/c', 'C:\\Users\\U\\.kimi-code\\bin\\kimi.cmd', 'login']);

    // Headless via stdio:'ignore' (closes stdin) — NOT a `</dev/null` shell
    // redirect string (POSIX-only, a Windows footgun).
    expect(opts.stdio).toBe('ignore');
    const flat = JSON.stringify([cmd, args]);
    expect(flat).not.toContain('/dev/null');
    expect(flat).not.toContain('< NUL');
    // HOME/USERPROFILE are pointed at the provisioned home so kimi writes config
    // there (not the CLI process's own home).
    expect(opts.env.HOME).toBe(tmpHome);
    expect(opts.env.USERPROFILE).toBe(tmpHome);
  });

  it('api_key path does NOT run kimi login (no config provisioning needed)', () => {
    const env = provisionAgentCredentials('kimi', { kind: 'api_key', value: 'sk-kimi' }, tmpHome);
    expect(env).toEqual({ KIMI_API_KEY: 'sk-kimi' });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});
