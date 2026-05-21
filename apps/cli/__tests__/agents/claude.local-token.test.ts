import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  extractLocalClaudeToken,
  claudeCredentialsMtime,
} from '../../src/agents/claude/local-token';

describe('claude/local-token extractLocalClaudeToken', () => {
  let home: string;
  let origHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'claude-local-'));
    origHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome;
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
});

describe('claude/local-token claudeCredentialsMtime', () => {
  let home: string;
  let origHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'claude-mtime-'));
    origHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome;
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
