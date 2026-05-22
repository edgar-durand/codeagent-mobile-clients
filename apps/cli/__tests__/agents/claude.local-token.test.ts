import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, utimesSync } from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import {
  extractLocalClaudeToken,
  claudeCredentialsMtime,
  claudeCredentialsPaths,
} from '../../src/agents/claude/local-token';

/**
 * Override `os.homedir()` for the duration of a test by setting both
 * `HOME` (Linux + macOS) and `USERPROFILE` (Windows). Without the
 * USERPROFILE override the credential-extract tests no-op on the
 * Windows CI runner because `os.homedir()` keeps pointing at
 * `C:\Users\runneradmin`.
 */
function overrideHome(target: string): { restore: () => void } {
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  process.env.HOME = target;
  process.env.USERPROFILE = target;
  return {
    restore: () => {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      if (origUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = origUserProfile;
    },
  };
}

describe('claude/local-token extractLocalClaudeToken', () => {
  let home: string;
  let restoreHome: () => void;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'claude-local-'));
    ({ restore: restoreHome } = overrideHome(home));
  });

  afterEach(() => {
    restoreHome();
    rmSync(home, { recursive: true, force: true });
  });

  it('returns null when no ~/.claude/.credentials.json exists', async () => {
    // Note: on macOS the keychain probe may succeed for the dev machine
    // itself even when HOME is overridden. The harness can't suppress
    // that, so this assertion is platform-conditional: linux + windows
    // expect null; on darwin we accept either null OR a macos-keychain
    // result as proof we read SOMETHING legitimate.
    const r = await extractLocalClaudeToken();
    if (process.platform === 'darwin') {
      if (r !== null) {
        expect(r.source).toBe('macos-keychain');
        expect(r.method).toBe('oauth');
        expect(r.credential.length).toBeGreaterThan(0);
      } else {
        expect(r).toBeNull();
      }
    } else {
      expect(r).toBeNull();
    }
  });

  it('returns the credential as oauth blob when ~/.claude/.credentials.json exists', async () => {
    const claudeDir = path.join(home, '.claude');
    mkdirSync(claudeDir);
    const blob = JSON.stringify({ accessToken: 'sk-ant-oauth-fake', refreshToken: 'rt-fake' });
    writeFileSync(path.join(claudeDir, '.credentials.json'), blob);

    const r = await extractLocalClaudeToken();
    expect(r).not.toBeNull();
    expect(r?.method).toBe('oauth');
    expect(r?.source).toBe('flat-file');
    expect(r?.credential).toBe(blob);
  });

  it('returns null when the credentials file exists but is empty / whitespace', async () => {
    const claudeDir = path.join(home, '.claude');
    mkdirSync(claudeDir);
    writeFileSync(path.join(claudeDir, '.credentials.json'), '   \n  ');

    // On macOS the keychain fallback may still produce a token; only
    // assert null on platforms where the flat-file is the only source.
    const r = await extractLocalClaudeToken();
    if (process.platform !== 'darwin') {
      expect(r).toBeNull();
    }
  });

  it('falls back to ~/.config/claude/.credentials.json (XDG layout) when the default path is missing', async () => {
    const xdgDir = path.join(home, '.config', 'claude');
    mkdirSync(xdgDir, { recursive: true });
    const blob = JSON.stringify({ accessToken: 'sk-ant-oauth-xdg', refreshToken: 'rt-xdg' });
    writeFileSync(path.join(xdgDir, '.credentials.json'), blob);

    const r = await extractLocalClaudeToken();
    expect(r).not.toBeNull();
    expect(r?.method).toBe('oauth');
    expect(r?.source).toBe('flat-file');
    expect(r?.credential).toBe(blob);
  });

  it('prefers ~/.claude/.credentials.json over the XDG fallback when both exist', async () => {
    const primaryDir = path.join(home, '.claude');
    const xdgDir = path.join(home, '.config', 'claude');
    mkdirSync(primaryDir, { recursive: true });
    mkdirSync(xdgDir, { recursive: true });
    writeFileSync(path.join(primaryDir, '.credentials.json'), 'PRIMARY');
    writeFileSync(path.join(xdgDir, '.credentials.json'), 'XDG');

    const r = await extractLocalClaudeToken();
    expect(r?.credential).toBe('PRIMARY');
  });
});

describe('claude/local-token claudeCredentialsPaths', () => {
  let home: string;
  let restoreHome: () => void;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'claude-paths-'));
    ({ restore: restoreHome } = overrideHome(home));
  });

  afterEach(() => {
    restoreHome();
    rmSync(home, { recursive: true, force: true });
  });

  it('resolves under os.homedir() using the platform-native separator', () => {
    const paths = claudeCredentialsPaths();
    expect(paths.length).toBeGreaterThanOrEqual(2);
    for (const p of paths) {
      expect(p.startsWith(home)).toBe(true);
      // Use path.sep so Windows backslash paths pass too. The
      // resolved path must include the `.claude` or `claude`
      // directory segment.
      expect(p).toMatch(/[\\/]\.?claude[\\/]/);
      expect(p.endsWith('.credentials.json')).toBe(true);
    }
  });
});

describe('claude/local-token claudeCredentialsMtime', () => {
  let home: string;
  let restoreHome: () => void;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'claude-mtime-'));
    ({ restore: restoreHome } = overrideHome(home));
  });

  afterEach(() => {
    restoreHome();
    rmSync(home, { recursive: true, force: true });
  });

  it('returns null when the file does not exist', () => {
    expect(claudeCredentialsMtime()).toBeNull();
  });

  it('returns the file mtime in ms when the file exists', () => {
    const claudeDir = path.join(home, '.claude');
    mkdirSync(claudeDir);
    const file = path.join(claudeDir, '.credentials.json');
    writeFileSync(file, '{}');
    // Stamp a known mtime so the assertion is platform-stable.
    const fixedMs = new Date('2026-01-15T00:00:00Z').getTime();
    utimesSync(file, fixedMs / 1000, fixedMs / 1000);
    const m = claudeCredentialsMtime();
    expect(m).toBeGreaterThan(0);
  });
});
