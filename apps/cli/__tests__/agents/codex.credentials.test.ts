import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  detectLocalCodexCredentials,
} from '../../src/agents/codex/credentials';

describe('codex/credentials detectLocalCodexCredentials', () => {
  let home: string;
  let origHome: string | undefined;
  let origOpenAi: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'codex-creds-'));
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

  it('returns none when ~/.codex/auth.json missing and no OPENAI_API_KEY', async () => {
    const r = await detectLocalCodexCredentials();
    expect(r.source).toBe('none');
  });

  it('returns flat-file when ~/.codex/auth.json exists', async () => {
    const codexDir = path.join(home, '.codex');
    mkdirSync(codexDir);
    writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({ access_token: 'tok' }));
    const r = await detectLocalCodexCredentials();
    expect(r.source).toBe('flat-file');
    expect(r.description).toContain('auth.json');
  });

  it('returns env-var when OPENAI_API_KEY is set and no flat-file', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const r = await detectLocalCodexCredentials();
    expect(r.source).toBe('env-var');
    expect(r.description).toContain('OPENAI_API_KEY');
  });

  it('prefers flat-file over env-var when both present', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const codexDir = path.join(home, '.codex');
    mkdirSync(codexDir);
    writeFileSync(path.join(codexDir, 'auth.json'), '{}');
    const r = await detectLocalCodexCredentials();
    expect(r.source).toBe('flat-file');
  });
});
