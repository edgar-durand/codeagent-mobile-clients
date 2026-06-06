/**
 * Tests for the local-token reader / validator used by
 * `codeam link gemini`. Mirrors the codex equivalent — no real
 * filesystem writes, just probe the path constant + validator.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractLocalGeminiToken,
  geminiCredentialsPath,
  geminiCredentialsPaths,
  validateLocalGeminiToken,
} from '../../src/agents/gemini/local-token';

describe('gemini local-token paths', () => {
  it('credentials path is ~/.gemini/oauth_creds.json', () => {
    expect(geminiCredentialsPath()).toBe(
      path.join(os.homedir(), '.gemini', 'oauth_creds.json'),
    );
  });

  it('paths array contains exactly the creds path (single source)', () => {
    expect(geminiCredentialsPaths()).toEqual([geminiCredentialsPath()]);
  });
});

describe('extractLocalGeminiToken', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-tok-'));
  const realPath = geminiCredentialsPath();
  // Point HOME at a sandbox dir for the duration of these specs so
  // we never read or write the developer's real ~/.gemini.
  const originalHome = process.env.HOME;
  beforeEach(() => {
    process.env.HOME = tmpDir;
  });
  afterEach(() => {
    process.env.HOME = originalHome;
  });

  it('returns null when the credentials file is absent', async () => {
    const sandboxPath = path.join(tmpDir, '.gemini', 'oauth_creds.json');
    if (fs.existsSync(sandboxPath)) fs.rmSync(sandboxPath);
    // Real homedir() reads the env var lazily — confirm the locator
    // points at the sandbox.
    expect(geminiCredentialsPath().startsWith(tmpDir)).toBe(true);
    expect(await extractLocalGeminiToken()).toBeNull();
  });

  it('returns null when the file exists but is empty / whitespace', async () => {
    const sandboxPath = path.join(tmpDir, '.gemini', 'oauth_creds.json');
    fs.mkdirSync(path.dirname(sandboxPath), { recursive: true });
    fs.writeFileSync(sandboxPath, '   \n\t  ');
    expect(await extractLocalGeminiToken()).toBeNull();
  });

  it('returns the file body as a flat-file oauth token', async () => {
    const sandboxPath = path.join(tmpDir, '.gemini', 'oauth_creds.json');
    fs.mkdirSync(path.dirname(sandboxPath), { recursive: true });
    const blob = JSON.stringify({
      access_token: 'ya29.fake',
      refresh_token: 'r.fake',
      expiry_date: Date.now() + 60_000,
    });
    fs.writeFileSync(sandboxPath, blob);
    const tok = await extractLocalGeminiToken();
    expect(tok).toEqual({ method: 'oauth', credential: blob, source: 'flat-file' });
  });

  // Re-pin realPath assertion so a future test that accidentally
  // writes outside the sandbox surfaces immediately.
  it('real homedir path is NOT inside the test sandbox', () => {
    process.env.HOME = originalHome;
    expect(geminiCredentialsPath()).toBe(realPath);
  });
});

describe('validateLocalGeminiToken', () => {
  it('returns unknown for non-JSON credentials (raw API key)', () => {
    expect(validateLocalGeminiToken('AIza-fake-api-key').status).toBe('unknown');
  });

  it('returns unknown when expiry_date is absent', () => {
    const blob = JSON.stringify({ access_token: 'a', refresh_token: 'r' });
    expect(validateLocalGeminiToken(blob).status).toBe('unknown');
  });

  it('returns expired for past expiry_date', () => {
    const blob = JSON.stringify({
      access_token: 'a',
      expiry_date: Date.now() - 60_000,
    });
    const r = validateLocalGeminiToken(blob);
    expect(r.status).toBe('expired');
    expect(r.reason).toMatch(/expired/i);
    expect(r.expiresAt).toBeDefined();
  });

  it('returns valid for future expiry_date', () => {
    const expiry = Date.now() + 3600_000;
    const blob = JSON.stringify({ access_token: 'a', expiry_date: expiry });
    const r = validateLocalGeminiToken(blob);
    expect(r.status).toBe('valid');
    expect(r.expiresAt).toBe(expiry);
  });
});
