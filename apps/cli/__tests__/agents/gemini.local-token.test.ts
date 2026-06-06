/**
 * Tests for the local-token reader / validator used by
 * `codeam link gemini`. Mirrors the codex equivalent — no real
 * filesystem writes, just probe the path constant + validator.
 */

import * as fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractLocalGeminiToken,
  geminiCredentialsPath,
  geminiCredentialsPaths,
  validateLocalGeminiToken,
} from '../../src/agents/gemini/local-token';

/**
 * Override `os.homedir()` for the duration of a test by setting both
 * `HOME` (Linux + macOS) and `USERPROFILE` (Windows). Without the
 * USERPROFILE override these tests would no-op on the Windows CI
 * runner — same pattern as codex.local-token.test.ts.
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

describe('gemini local-token paths', () => {
  it('credentials path is <homedir>/.gemini/oauth_creds.json', () => {
    expect(geminiCredentialsPath()).toBe(
      path.join(os.homedir(), '.gemini', 'oauth_creds.json'),
    );
  });

  it('paths array contains exactly the creds path (single source)', () => {
    expect(geminiCredentialsPaths()).toEqual([geminiCredentialsPath()]);
  });
});

describe('extractLocalGeminiToken', () => {
  let home: string;
  let restoreHome: () => void;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'gemini-local-'));
    ({ restore: restoreHome } = overrideHome(home));
  });

  afterEach(() => {
    restoreHome();
    rmSync(home, { recursive: true, force: true });
  });

  it('returns null when ~/.gemini/oauth_creds.json missing', async () => {
    expect(await extractLocalGeminiToken()).toBeNull();
  });

  it('returns null when the file exists but is empty / whitespace', async () => {
    const sandboxPath = path.join(home, '.gemini', 'oauth_creds.json');
    fs.mkdirSync(path.dirname(sandboxPath), { recursive: true });
    fs.writeFileSync(sandboxPath, '   \n\t  ');
    expect(await extractLocalGeminiToken()).toBeNull();
  });

  it('returns the file body as a flat-file oauth token', async () => {
    const sandboxPath = path.join(home, '.gemini', 'oauth_creds.json');
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
