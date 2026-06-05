import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import {
  extractLocalCodexToken,
  codexCredentialsMtime,
  codexCredentialsPaths,
  validateLocalCodexToken,
} from '../../src/agents/codex/local-token';

function makeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
    'base64url',
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.`;
}

/**
 * Override `os.homedir()` for the duration of a test by setting both
 * `HOME` (Linux + macOS) and `USERPROFILE` (Windows). Without the
 * USERPROFILE override these tests would no-op on the Windows CI
 * runner.
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

describe('codex/local-token extractLocalCodexToken', () => {
  let home: string;
  let restoreHome: () => void;
  let origOpenAi: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'codex-local-'));
    ({ restore: restoreHome } = overrideHome(home));
    origOpenAi = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (origOpenAi !== undefined) process.env.OPENAI_API_KEY = origOpenAi;
    restoreHome();
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

  it('returns null when ~/.codex/auth.json exists but is empty / whitespace', async () => {
    const dir = path.join(home, '.codex');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'auth.json'), '   \n   ');
    const r = await extractLocalCodexToken();
    expect(r).toBeNull();
  });
});

describe('codex/local-token codexCredentialsPaths', () => {
  let home: string;
  let restoreHome: () => void;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'codex-paths-'));
    ({ restore: restoreHome } = overrideHome(home));
  });

  afterEach(() => {
    restoreHome();
    rmSync(home, { recursive: true, force: true });
  });

  it('resolves under os.homedir() using the platform-native separator', () => {
    const paths = codexCredentialsPaths();
    expect(paths.length).toBe(1);
    expect(paths[0].startsWith(home)).toBe(true);
    expect(paths[0]).toMatch(/[\\/]\.codex[\\/]auth\.json$/);
  });
});

describe('codex/local-token codexCredentialsMtime', () => {
  let home: string;
  let restoreHome: () => void;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'codex-mtime-'));
    ({ restore: restoreHome } = overrideHome(home));
  });

  afterEach(() => {
    restoreHome();
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

describe('validateLocalCodexToken', () => {
  it('returns unknown for a raw OPENAI_API_KEY (non-JSON credential)', () => {
    expect(validateLocalCodexToken('sk-test-key')).toEqual({ status: 'unknown' });
  });

  it('returns unknown when no expiry signal is present anywhere', () => {
    const blob = JSON.stringify({ tokens: { access_token: 'sk-x' } });
    expect(validateLocalCodexToken(blob)).toEqual({ status: 'unknown' });
  });

  it('detects expiry from top-level expires_at (legacy auth.json)', () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const result = validateLocalCodexToken(JSON.stringify({ expires_at: past }));
    expect(result.status).toBe('expired');
    expect(result.reason).toMatch(/expired/i);
  });

  it('detects expiry from tokens.expires_at (intermediate auth.json)', () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const result = validateLocalCodexToken(
      JSON.stringify({ tokens: { expires_at: past } }),
    );
    expect(result.status).toBe('expired');
  });

  it('detects expiry from tokens.id_token JWT exp claim (current auth.json)', () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const jwt = makeJwt({ exp: past, sub: 'user-1' });
    const result = validateLocalCodexToken(
      JSON.stringify({ tokens: { id_token: jwt } }),
    );
    expect(result.status).toBe('expired');
    expect(result.expiresAt).toBe(past * 1000);
  });

  it('returns valid when id_token JWT exp is in the future', () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const jwt = makeJwt({ exp: future });
    const result = validateLocalCodexToken(
      JSON.stringify({ tokens: { id_token: jwt } }),
    );
    expect(result.status).toBe('valid');
    expect(result.expiresAt).toBe(future * 1000);
  });

  it('prefers explicit expires_at over the id_token JWT exp when both present', () => {
    const expired = Math.floor(Date.now() / 1000) - 60;
    const future = Math.floor(Date.now() / 1000) + 3600;
    const jwt = makeJwt({ exp: future });
    const result = validateLocalCodexToken(
      JSON.stringify({ expires_at: expired, tokens: { id_token: jwt } }),
    );
    expect(result.status).toBe('expired');
  });

  it('returns unknown when the JWT has wrong segment count', () => {
    expect(
      validateLocalCodexToken(
        JSON.stringify({ tokens: { id_token: 'not-a-jwt' } }),
      ).status,
    ).toBe('unknown');
  });

  it('returns unknown when the JWT payload is not parseable JSON', () => {
    expect(
      validateLocalCodexToken(
        JSON.stringify({ tokens: { id_token: 'a.b.c' } }),
      ).status,
    ).toBe('unknown');
  });
});
