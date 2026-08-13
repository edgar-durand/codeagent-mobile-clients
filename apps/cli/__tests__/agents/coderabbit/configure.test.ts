import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureCoderabbit } from '../../../src/agents/coderabbit/configure';
import type { OsStrategy } from '../../../src/os';

function fakeOs(hasBinary: boolean): OsStrategy {
  return {
    id: 'linux',
    findInPath: () => (hasBinary ? '/usr/bin/coderabbit' : null),
    homeDir: () => '/home/test',
    augmentPath: () => {},
  } as unknown as OsStrategy;
}

describe('configureCoderabbit — status', () => {
  it('reports installed + loggedIn', async () => {
    const res = await configureCoderabbit(
      { action: 'status' },
      { os: fakeOs(true), isLoggedIn: () => true },
    );
    expect(res).toMatchObject({ supported: true, installed: true, loggedIn: true, linked: true });
  });

  it('reports not-installed', async () => {
    const res = await configureCoderabbit({ action: 'status' }, { os: fakeOs(false) });
    expect(res).toMatchObject({ installed: false, loggedIn: false });
  });
});

describe('configureCoderabbit — link_apikey', () => {
  it('authenticates via `coderabbit auth login --api-key` THEN vaults the key', async () => {
    const upload = vi.fn(async () => true);
    const loginWithApiKey = vi.fn(() => ({ ok: true }));
    const res = await configureCoderabbit(
      { action: 'link_apikey', apiKey: 'cr-abc' },
      { os: fakeOs(true), uploadCredential: upload, loginWithApiKey },
    );
    // Auth login runs (the official headless method) — not just a vault write.
    expect(loginWithApiKey).toHaveBeenCalledWith('cr-abc');
    expect(upload).toHaveBeenCalledWith('api_key', 'cr-abc');
    expect(res).toMatchObject({ loggedIn: true, linked: true });
  });

  it('does NOT vault an invalid/expired key — surfaces CodeRabbit’s error', async () => {
    const upload = vi.fn(async () => true);
    const res = await configureCoderabbit(
      { action: 'link_apikey', apiKey: 'cr-bad' },
      {
        os: fakeOs(true),
        uploadCredential: upload,
        loginWithApiKey: () => ({ ok: false, error: 'Invalid or expired API key.' }),
      },
    );
    expect(upload).not.toHaveBeenCalled();
    expect(res.linked).toBe(false);
    expect(res.error).toMatch(/Invalid or expired API key/);
  });

  it('errors on an empty key', async () => {
    const res = await configureCoderabbit(
      { action: 'link_apikey', apiKey: '  ' },
      { os: fakeOs(true), uploadCredential: vi.fn(async () => true) },
    );
    expect(res.linked).toBeUndefined();
    expect(res.error).toMatch(/No API key/);
  });
});

describe('configureCoderabbit — link_oauth', () => {
  it('drives OAuth, captures the credential, stores it as an {file,contents} blob', async () => {
    const upload = vi.fn(async (_method: 'oauth' | 'api_key', _credential: string) => true);
    const onEvent = vi.fn();
    const res = await configureCoderabbit(
      { action: 'link_oauth' },
      {
        os: fakeOs(true),
        ensureInstalled: async () => ({ ok: true }),
        runOAuthLogin: async (deps) => {
          deps.onEvent?.({ kind: 'awaiting_browser', authUrl: 'https://app.coderabbit.ai/login?x' });
          return { ok: true, user: { username: 'edgar' }, provider: 'github', org: 'Acme' };
        },
        snapshotDir: () => ({}),
        captureCredential: () => ({ file: 'auth.json', contents: '{"access_token":"blob"}' }),
        uploadCredential: upload,
        onEvent,
      },
    );
    expect(res).toMatchObject({ loggedIn: true, linked: true, provider: 'github', org: 'Acme' });
    // The credential stored is the filename-agnostic envelope.
    const [method, credential] = upload.mock.calls[0];
    expect(method).toBe('oauth');
    expect(JSON.parse(credential)).toEqual({ file: 'auth.json', contents: '{"access_token":"blob"}' });
    // The browser URL was surfaced to the app.
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'awaiting_browser' }));
  });

  it('gives the browser-gated login a user-paced timeout (>= 15 min, not the 180 s default)', async () => {
    // 2026-07-13 incident: the user's real sign-in (account creation + IdP
    // round-trips) landed AFTER two consecutive 180 s windows had killed the
    // waiting `coderabbit auth login`, so the relayed callback had nothing to
    // complete. The login is user-paced — it must get a generous budget.
    let seenTimeout: number | undefined;
    await configureCoderabbit(
      { action: 'link_oauth' },
      {
        os: fakeOs(true),
        ensureInstalled: async () => ({ ok: true }),
        runOAuthLogin: async (deps) => {
          seenTimeout = deps.timeoutMs;
          return { ok: true, user: { username: 'edgar' } };
        },
        snapshotDir: () => ({}),
        captureCredential: () => ({ file: 'auth.json', contents: '{}' }),
        uploadCredential: vi.fn(async () => true),
      },
    );
    expect(seenTimeout).toBeDefined();
    expect(seenTimeout!).toBeGreaterThanOrEqual(900_000);
  });

  it('reports the OAuth error without storing anything', async () => {
    const upload = vi.fn(async () => true);
    const res = await configureCoderabbit(
      { action: 'link_oauth' },
      {
        os: fakeOs(true),
        ensureInstalled: async () => ({ ok: true }),
        runOAuthLogin: async () => ({ ok: false, error: 'Failed to fetch user data' }),
        snapshotDir: () => ({}),
        captureCredential: () => null,
        uploadCredential: upload,
      },
    );
    expect(res.linked).toBe(false);
    expect(res.error).toBe('Failed to fetch user data');
    expect(upload).not.toHaveBeenCalled();
  });

  it('signals a partial success when signed in but no credential file captured', async () => {
    const res = await configureCoderabbit(
      { action: 'link_oauth' },
      {
        os: fakeOs(true),
        ensureInstalled: async () => ({ ok: true }),
        runOAuthLogin: async () => ({ ok: true, user: { username: 'e' } }),
        snapshotDir: () => ({}),
        captureCredential: () => null, // couldn't identify the written file
        uploadCredential: vi.fn(async () => true),
      },
    );
    expect(res.loggedIn).toBe(true);
    expect(res.linked).toBe(false);
    expect(res.error).toMatch(/could not be captured/);
  });
});

describe('configureCoderabbit — review', () => {
  it('runs the reviewer and returns findings', async () => {
    const res = await configureCoderabbit(
      { action: 'review', review: { changeSet: 'uncommitted' } },
      {
        os: fakeOs(true),
        runReview: async (input) => {
          expect(input.changeSet).toBe('uncommitted');
          return {
            exitCode: 0,
            markdown: 'Found 1 issue',
            hunks: [{ path: 'a.ts', line: 4, severity: 'error', message: 'boom' }],
            stats: { findingCount: 1 },
          };
        },
      },
    );
    expect(res.review?.hunks?.length).toBe(1);
    expect(res.review?.markdown).toBe('Found 1 issue');
  });

  it('errors when no reviewer is available', async () => {
    const res = await configureCoderabbit({ action: 'review' }, { os: fakeOs(true) });
    expect(res.error).toMatch(/No reviewer/);
  });
});

describe('configureCoderabbit — provision (from vault, no re-login)', () => {
  it('api_key: authenticates with the vaulted key and reports linked', async () => {
    const loginWithApiKey = vi.fn(() => ({ ok: true }));
    const res = await configureCoderabbit(
      { action: 'provision', provisionCredential: { method: 'api_key', credential: 'cr-vaulted' } },
      { os: fakeOs(true), loginWithApiKey },
    );
    expect(loginWithApiKey).toHaveBeenCalledWith('cr-vaulted');
    expect(res.loggedIn).toBe(true);
    expect(res.linked).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it('api_key: surfaces an error when the vaulted key is rejected', async () => {
    const loginWithApiKey = vi.fn(() => ({ ok: false, error: 'bad key' }));
    const res = await configureCoderabbit(
      { action: 'provision', provisionCredential: { method: 'api_key', credential: 'cr-x' } },
      { os: fakeOs(true), loginWithApiKey },
    );
    expect(res.linked).toBe(false);
    expect(res.error).toBe('bad key');
  });

  it('errors when there is no vaulted credential to provision', async () => {
    const res = await configureCoderabbit({ action: 'provision' }, { os: fakeOs(true) });
    expect(res.linked).toBeUndefined();
    expect(res.error).toMatch(/no vaulted/i);
  });
});

describe('configureCoderabbit — install failures are ACTIONABLE, never generic', () => {
  // 2026-08-13: `provision` on a box without `unzip` reported the opaque
  // "CodeRabbit CLI could not be installed", so neither the user nor the logs
  // ever learned the real blocker. The installer's reason must survive intact.
  const REASON =
    "CodeRabbit's installer needs unzip on this machine, and it couldn't be installed automatically";

  it('provision surfaces the installer reason', async () => {
    const res = await configureCoderabbit(
      {
        action: 'provision',
        provisionCredential: { method: 'oauth', credential: '{"file":"auth.json","contents":"x"}' },
      },
      { os: fakeOs(false), ensureInstalled: async () => ({ ok: false, error: REASON }) },
    );
    expect(res.linked).toBeFalsy();
    expect(res.error).toBe(REASON);
  });

  it('link_oauth surfaces the installer reason', async () => {
    const res = await configureCoderabbit(
      { action: 'link_oauth' },
      { os: fakeOs(false), ensureInstalled: async () => ({ ok: false, error: REASON }) },
    );
    expect(res.error).toBe(REASON);
  });

  it('review surfaces the installer reason', async () => {
    const res = await configureCoderabbit(
      { action: 'review' },
      { os: fakeOs(false), ensureInstalled: async () => ({ ok: false, error: REASON }) },
    );
    expect(res.error).toBe(REASON);
  });

  it('falls back to a generic message only when the installer gives no reason', async () => {
    const res = await configureCoderabbit(
      { action: 'link_apikey', apiKey: 'cr-abc' },
      { os: fakeOs(false), ensureInstalled: async () => ({ ok: false }) },
    );
    expect(res.error).toBe('CodeRabbit CLI could not be installed');
  });
});

describe('configureCoderabbit — provision VERIFIES the restored credential', () => {
  // Writing the vaulted blob to disk proves nothing about its validity: a
  // revoked/rotated CodeRabbit login restores fine and then 401s on the first
  // review, while the app happily showed "linked". Provision must agree with
  // `coderabbit auth status` before claiming success.
  const BLOB = JSON.stringify({ file: 'auth.json', contents: 'opaque' });

  // Hermetic HOME — the restore writes `<home>/.coderabbit/auth.json`, and it
  // must never reach the developer's real credential file.
  let home: string;
  const sandboxOs = (): OsStrategy =>
    ({ ...fakeOs(true), homeDir: () => home }) as unknown as OsStrategy;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codeam-cr-home-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('reports linked when CodeRabbit confirms the restored session', async () => {
    const res = await configureCoderabbit(
      { action: 'provision', provisionCredential: { method: 'oauth', credential: BLOB } },
      { os: sandboxOs(), isLoggedIn: () => true },
    );
    expect(res).toMatchObject({ loggedIn: true, linked: true });
    expect(res.error).toBeUndefined();
  });

  it('reports a re-link error when the restored credential is rejected', async () => {
    const res = await configureCoderabbit(
      { action: 'provision', provisionCredential: { method: 'oauth', credential: BLOB } },
      { os: sandboxOs(), isLoggedIn: () => false },
    );
    expect(res).toMatchObject({ loggedIn: false, linked: false });
    expect(res.error).toMatch(/couldn't be confirmed/i);
  });
});
