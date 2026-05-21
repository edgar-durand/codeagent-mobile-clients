import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  extractLocalCodexToken,
  codexCredentialsMtime,
} from '../../src/agents/codex/local-token';

describe('codex/local-token extractLocalCodexToken', () => {
  let home: string;
  let origHome: string | undefined;
  let origOpenAi: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'codex-local-'));
    origHome = process.env.HOME;
    origOpenAi = process.env.OPENAI_API_KEY;
    process.env.HOME = home;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome;
    if (origOpenAi !== undefined) process.env.OPENAI_API_KEY = origOpenAi;
    rmSync(home, { recursive: true, force: true });
  });

  it('returns null when ~/.codex/auth.json missing', async () => {
    const r = await extractLocalCodexToken();
    expect(r).toBeNull();
  });

  it('returns oauth blob when ~/.codex/auth.json exists', async () => {
    const dir = path.join(home, '.codex');
    mkdirSync(dir);
    const blob = JSON.stringify({ access_token: 'sk-openai-oauth-fake' });
    writeFileSync(path.join(dir, 'auth.json'), blob);

    const r = await extractLocalCodexToken();
    expect(r).not.toBeNull();
    expect(r?.method).toBe('oauth');
    expect(r?.source).toBe('flat-file');
    expect(r?.credential).toBe(blob);
  });

  it('does NOT fall back to OPENAI_API_KEY (unlike the codespace-deploy bridge)', async () => {
    // The link command's promise is "we captured your codex login" —
    // returning an API key from an env var would be a surprising
    // implicit fallback. Mobile's "Paste an API key" flow exists for
    // that case.
    process.env.OPENAI_API_KEY = 'sk-openai-from-env';
    const r = await extractLocalCodexToken();
    expect(r).toBeNull();
  });
});

describe('codex/local-token codexCredentialsMtime', () => {
  let home: string;
  let origHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'codex-mtime-'));
    origHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('returns null when the file does not exist', () => {
    expect(codexCredentialsMtime()).toBeNull();
  });

  it('returns a positive number when the file exists', () => {
    const dir = path.join(home, '.codex');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'auth.json'), '{}');
    const m = codexCredentialsMtime();
    expect(m).not.toBeNull();
    expect(m).toBeGreaterThan(0);
  });
});
