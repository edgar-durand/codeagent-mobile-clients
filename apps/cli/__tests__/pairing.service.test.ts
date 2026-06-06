import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use the real module but mock internal http calls with vi.spyOn after import
import * as pairing from '../src/services/pairing.service';
import * as gitBranch from '../src/lib/git-branch';

describe('requestCode', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns code and expiresAt on success', async () => {
    vi.spyOn(pairing._transport, 'postJson').mockResolvedValue({
      data: { code: 'ABC123', expiresAt: 9999999999000 },
    } as never);

    const result = await pairing.requestCode('plugin-1');
    expect(result).toEqual({ code: 'ABC123', expiresAt: 9999999999000 });
  });

  it('returns null when server fails', async () => {
    vi.spyOn(pairing._transport, 'postJson').mockResolvedValue(null);
    const result = await pairing.requestCode('plugin-1');
    expect(result).toBeNull();
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
