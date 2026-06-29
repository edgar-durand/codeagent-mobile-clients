import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use the real module but mock internal http calls with vi.spyOn after import
import * as pairing from '../src/services/pairing.service';
import * as gitBranch from '../src/lib/git-branch';
import pkg from '../package.json';

describe('requestCode', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns ok: true with code and expiresAt on success', async () => {
    vi.spyOn(pairing._transport, 'postJson').mockResolvedValue({
      data: { code: 'ABC123', expiresAt: 9999999999000 },
    } as never);

    const result = await pairing.requestCode('plugin-1');
    expect(result).toEqual({ ok: true, code: 'ABC123', expiresAt: 9999999999000 });
  });

  it('returns ok: false reason=network when server returns null body', async () => {
    vi.spyOn(pairing._transport, 'postJson').mockResolvedValue(null);
    const result = await pairing.requestCode('plugin-1');
    expect(result).toEqual({ ok: false, reason: 'network' });
  });

  it('returns ok: false reason=rate-limited with retry-after on a 429', async () => {
    const err = new Error('HTTP 429') as Error & {
      statusCode: number;
      retryAfterSeconds: number;
    };
    err.statusCode = 429;
    err.retryAfterSeconds = 47;
    vi.spyOn(pairing._transport, 'postJson').mockRejectedValue(err);
    const result = await pairing.requestCode('plugin-1');
    expect(result).toEqual({
      ok: false,
      reason: 'rate-limited',
      retryAfterSeconds: 47,
    });
  });

  it('returns ok: false reason=http with status when transport rejects with a non-429 status', async () => {
    const err = new Error('HTTP 503') as Error & { statusCode: number };
    err.statusCode = 503;
    vi.spyOn(pairing._transport, 'postJson').mockRejectedValue(err);
    const result = await pairing.requestCode('plugin-1');
    expect(result).toEqual({ ok: false, reason: 'http', status: 503 });
  });

  it('includes the detected git branch in the pair POST body', async () => {
    vi.spyOn(gitBranch, 'detectCurrentBranch').mockReturnValue('feature/x');
    const postSpy = vi
      .spyOn(pairing._transport, 'postJson')
      .mockResolvedValue({ data: { code: 'C', expiresAt: 1 } } as never);

    await pairing.requestCode('plugin-1');

    expect(postSpy).toHaveBeenCalledTimes(1);
    const [, body] = postSpy.mock.calls[0];
    expect(body).toMatchObject({ pluginId: 'plugin-1', branch: 'feature/x' });
  });

  it('sends branch:null when not in a git repo / detached HEAD', async () => {
    vi.spyOn(gitBranch, 'detectCurrentBranch').mockReturnValue(null);
    const postSpy = vi
      .spyOn(pairing._transport, 'postJson')
      .mockResolvedValue({ data: { code: 'C', expiresAt: 1 } } as never);

    await pairing.requestCode('plugin-1');

    const [, body] = postSpy.mock.calls[0];
    expect(body).toMatchObject({ branch: null });
  });
});

describe('fetchCurrentPluginAuthToken', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('includes ideVersion equal to the running package version in the reconnect body', async () => {
    const postSpy = vi
      .spyOn(pairing._transport, 'postJson')
      .mockResolvedValue({
        data: { paired: true, pluginAuthToken: 'v1.fake-token' },
      } as never);

    await pairing.fetchCurrentPluginAuthToken('sess-1', 'plugin-1');

    expect(postSpy).toHaveBeenCalledTimes(1);
    const [url, body] = postSpy.mock.calls[0];
    expect(url).toMatch(/\/api\/pairing\/reconnect$/);
    expect(body).toMatchObject({
      sessionId: 'sess-1',
      pluginId: 'plugin-1',
      ideVersion: pkg.version,
    });
  });

  it('returns the pluginAuthToken from a successful reconnect response', async () => {
    vi.spyOn(pairing._transport, 'postJson').mockResolvedValue({
      data: { paired: true, pluginAuthToken: 'v1.the-real-token' },
    } as never);

    const token = await pairing.fetchCurrentPluginAuthToken('sess-1', 'plugin-1');
    expect(token).toBe('v1.the-real-token');
  });

  it('returns null when paired is false in the response', async () => {
    vi.spyOn(pairing._transport, 'postJson').mockResolvedValue({
      data: { paired: false },
    } as never);

    const token = await pairing.fetchCurrentPluginAuthToken('sess-1', 'plugin-1');
    expect(token).toBeNull();
  });

  it('returns null on network error', async () => {
    vi.spyOn(pairing._transport, 'postJson').mockRejectedValue(new Error('ECONNREFUSED'));

    const token = await pairing.fetchCurrentPluginAuthToken('sess-1', 'plugin-1');
    expect(token).toBeNull();
  });
});

describe('postLinkCredential', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('POSTs the credential blob with X-Plugin-Auth-Token + sessionId+pluginId in body', async () => {
    const spy = vi
      .spyOn(pairing._transport, 'postJsonAuthed')
      .mockResolvedValue({ success: true, data: { status: 'persisted' } } as never);

    const result = await pairing.postLinkCredential({
      agentId: 'claude_code',
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      pluginAuthToken: 'v1.fake-hmac',
      method: 'oauth',
      credential: '{"accessToken":"sk-ant"}',
    });

    expect(result).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, body, token] = spy.mock.calls[0];
    expect(url).toMatch(/\/api\/plugin\/agents\/claude_code\/link$/);
    expect(body).toMatchObject({
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      method: 'oauth',
      credential: '{"accessToken":"sk-ant"}',
    });
    expect(token).toBe('v1.fake-hmac');
  });

  it('returns { ok: false, status, message } on HTTP error', async () => {
    const err = Object.assign(new Error('HTTP 401: bad token'), { statusCode: 401 });
    vi.spyOn(pairing._transport, 'postJsonAuthed').mockRejectedValue(err);

    const result = await pairing.postLinkCredential({
      agentId: 'codex',
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      pluginAuthToken: 'v1.bad',
      method: 'oauth',
      credential: '{"x":1}',
    });

    expect(result).toEqual({ ok: false, status: 401, message: 'HTTP 401: bad token' });
  });

  it('forwards modelPreference when supplied', async () => {
    const spy = vi
      .spyOn(pairing._transport, 'postJsonAuthed')
      .mockResolvedValue({ success: true } as never);

    await pairing.postLinkCredential({
      agentId: 'claude_code',
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      pluginAuthToken: 'v1.tok',
      method: 'api_key',
      credential: 'sk-ant-test',
      modelPreference: 'claude-opus-4-7',
    });

    const [, body] = spy.mock.calls[0];
    expect(body).toMatchObject({ modelPreference: 'claude-opus-4-7' });
  });

  it('does NOT include modelPreference when omitted (avoid sending undefined)', async () => {
    const spy = vi
      .spyOn(pairing._transport, 'postJsonAuthed')
      .mockResolvedValue({ success: true } as never);

    await pairing.postLinkCredential({
      agentId: 'codex',
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      pluginAuthToken: 'v1.tok',
      method: 'oauth',
      credential: '{"x":1}',
    });

    const [, body] = spy.mock.calls[0];
    expect(Object.keys(body)).not.toContain('modelPreference');
  });
});
