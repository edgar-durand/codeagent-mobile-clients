import { describe, it, expect, vi } from 'vitest';
import { configureCoderabbit } from '../../../src/agents/coderabbit/configure';
import type { OsStrategy } from '../../../src/os';

function fakeOs(hasBinary: boolean): OsStrategy {
  return {
    findInPath: () => (hasBinary ? '/usr/bin/coderabbit' : null),
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
  it('stores the key and reports linked', async () => {
    const upload = vi.fn(async () => true);
    const res = await configureCoderabbit(
      { action: 'link_apikey', apiKey: 'cr-abc' },
      { os: fakeOs(true), uploadCredential: upload },
    );
    expect(upload).toHaveBeenCalledWith('api_key', 'cr-abc');
    expect(res.linked).toBe(true);
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
        ensureInstalled: async () => true,
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

  it('reports the OAuth error without storing anything', async () => {
    const upload = vi.fn(async () => true);
    const res = await configureCoderabbit(
      { action: 'link_oauth' },
      {
        os: fakeOs(true),
        ensureInstalled: async () => true,
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
        ensureInstalled: async () => true,
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
