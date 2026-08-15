import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use the real module but mock internal http calls with vi.spyOn after import
import * as pairing from '../src/services/pairing.service';
import * as gitBranch from '../src/lib/git-branch';
import pkg from '../package.json';

describe('requestCode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes ideVersion equal to the running package version in the reconnect body', async () => {
    const postSpy = vi.spyOn(pairing._transport, 'postJson').mockResolvedValue({
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

describe('postAgentReviewReport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs the report to /api/vcs/agent-review/report with X-Plugin-Auth-Token + sessionId/pluginId', async () => {
    const spy = vi
      .spyOn(pairing._transport, 'postJsonAuthed')
      .mockResolvedValue({ success: true } as never);

    const report = {
      prRef: { owner: 'acme', repo: 'web', number: 42, url: 'https://github.com/acme/web/pull/42' },
      agentId: 'coderabbit',
      verdict: 'request_changes' as const,
      commentCount: 2,
      findings: [{ path: 'src/a.ts', line: 10, severity: 'error' as const, message: 'null deref' }],
    };

    const result = await pairing.postAgentReviewReport({
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      pluginAuthToken: 'v1.tok',
      report,
    });

    expect(result).toEqual({ ok: true });
    const [url, body, token] = spy.mock.calls[0];
    expect(url).toMatch(/\/api\/vcs\/agent-review\/report$/);
    expect(body).toMatchObject({ sessionId: 'sess-1', pluginId: 'plug-1', report });
    expect(token).toBe('v1.tok');
  });

  it('returns { ok: false, status, message } on HTTP error (non-fatal)', async () => {
    const err = Object.assign(new Error('HTTP 403: missing scope'), { statusCode: 403 });
    vi.spyOn(pairing._transport, 'postJsonAuthed').mockRejectedValue(err);

    const result = await pairing.postAgentReviewReport({
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      pluginAuthToken: 'v1.tok',
      report: {
        prRef: { owner: 'acme', repo: 'web', number: 1 },
        agentId: 'coderabbit',
        verdict: 'approve',
        commentCount: 0,
      },
    });

    expect(result).toEqual({ ok: false, status: 403, message: 'HTTP 403: missing scope' });
  });
});

describe('postLinkCredential', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

describe('fetchProvisionCredentialDetailed', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok:true with method/credential/installScript on a valid payload', async () => {
    vi.spyOn(pairing._transport, 'postJsonAuthed').mockResolvedValue({
      data: { method: 'oauth', credential: '{"t":1}', installScript: 'echo hi' },
    } as never);

    const result = await pairing.fetchProvisionCredentialDetailed({
      agentId: 'claude_code',
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      pluginAuthToken: 'v1.tok',
      includeInstallScript: true,
    });

    expect(result).toEqual({
      ok: true,
      method: 'oauth',
      credential: '{"t":1}',
      installScript: 'echo hi',
    });
  });

  it('returns ok:false with the backend CODE + MESSAGE verbatim on the REAL api-v2 error envelope (409 CREDENTIAL_EXPIRED)', async () => {
    // The ACTUAL wire shape (api-v2's AllExceptionsFilter, which serializes
    // EVERY DomainHttpException this way — see the doc-comment atop
    // `plugin-linked-agents.controller.ts`): NESTED under `error`, not a flat
    // `{code, message}`. This is the exact body a fleet-1 harness run fed the
    // real transport (2026-08-15) — a flat-shape assumption here previously
    // let this test pass while the real credential-fetch path stayed broken.
    const backendMessage =
      'The vaulted "claude_code" credential expired and could not be refreshed — re-link the agent';
    const body = JSON.stringify({
      success: false,
      error: { code: 'CREDENTIAL_EXPIRED', message: backendMessage },
    });
    const err = Object.assign(new Error(`HTTP 409: ${body.slice(0, 200)}`), {
      statusCode: 409,
      body,
    });
    vi.spyOn(pairing._transport, 'postJsonAuthed').mockRejectedValue(err);

    const result = await pairing.fetchProvisionCredentialDetailed({
      agentId: 'claude_code',
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      pluginAuthToken: 'v1.tok',
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      code: 'CREDENTIAL_EXPIRED',
      message: backendMessage,
    });
  });

  it('also accepts a flat {code, message} body (defensive fallback for any endpoint not using the nested envelope)', async () => {
    const body = JSON.stringify({ code: 'NOT_AVAILABLE', message: 'flat-shape message' });
    const err = Object.assign(new Error(`HTTP 409: ${body}`), { statusCode: 409, body });
    vi.spyOn(pairing._transport, 'postJsonAuthed').mockRejectedValue(err);

    const result = await pairing.fetchProvisionCredentialDetailed({
      agentId: 'claude_code',
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      pluginAuthToken: 'v1.tok',
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      code: 'NOT_AVAILABLE',
      message: 'flat-shape message',
    });
  });

  it('returns ok:false with no code/message on a plain 404 (no vaulted credential) — the "truly absent" case', async () => {
    const err = Object.assign(new Error('HTTP 404: Not Found'), { statusCode: 404 });
    vi.spyOn(pairing._transport, 'postJsonAuthed').mockRejectedValue(err);

    const result = await pairing.fetchProvisionCredentialDetailed({
      agentId: 'claude_code',
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      pluginAuthToken: 'v1.tok',
    });

    expect(result).toEqual({ ok: false, status: 404, code: undefined, message: undefined });
  });

  it('returns ok:false, status:0 on a network failure (no statusCode at all)', async () => {
    vi.spyOn(pairing._transport, 'postJsonAuthed').mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await pairing.fetchProvisionCredentialDetailed({
      agentId: 'claude_code',
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      pluginAuthToken: 'v1.tok',
    });

    expect(result).toEqual({ ok: false, status: 0, code: undefined, message: undefined });
  });

  it('returns ok:false when the 2xx payload is malformed/missing (no code/message to surface)', async () => {
    vi.spyOn(pairing._transport, 'postJsonAuthed').mockResolvedValue({ data: {} } as never);

    const result = await pairing.fetchProvisionCredentialDetailed({
      agentId: 'claude_code',
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      pluginAuthToken: 'v1.tok',
    });

    expect(result).toEqual({ ok: false, status: 0 });
  });

  it('ignores an unparseable error body instead of throwing', async () => {
    const err = Object.assign(new Error('HTTP 500: <html>oops</html>'), {
      statusCode: 500,
      body: '<html>oops</html>',
    });
    vi.spyOn(pairing._transport, 'postJsonAuthed').mockRejectedValue(err);

    const result = await pairing.fetchProvisionCredentialDetailed({
      agentId: 'claude_code',
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      pluginAuthToken: 'v1.tok',
    });

    expect(result).toEqual({ ok: false, status: 500, code: undefined, message: undefined });
  });
});

describe('fetchProvisionCredential (legacy null-on-any-failure contract)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the credential (unwrapped, no `ok`) on success', async () => {
    vi.spyOn(pairing._transport, 'postJsonAuthed').mockResolvedValue({
      data: { method: 'api_key', credential: 'sk-ant-test' },
    } as never);

    const result = await pairing.fetchProvisionCredential({
      agentId: 'claude_code',
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      pluginAuthToken: 'v1.tok',
    });

    expect(result).toEqual({ method: 'api_key', credential: 'sk-ant-test' });
  });

  it('collapses a structured backend error (e.g. CREDENTIAL_EXPIRED, real nested envelope) to null — same as any other failure', async () => {
    const body = JSON.stringify({
      success: false,
      error: { code: 'CREDENTIAL_EXPIRED', message: 'expired' },
    });
    const err = Object.assign(new Error(`HTTP 409: ${body}`), { statusCode: 409, body });
    vi.spyOn(pairing._transport, 'postJsonAuthed').mockRejectedValue(err);

    const result = await pairing.fetchProvisionCredential({
      agentId: 'claude_code',
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      pluginAuthToken: 'v1.tok',
    });

    expect(result).toBeNull();
  });

  it('returns null on a 404 (no vaulted credential)', async () => {
    const err = Object.assign(new Error('HTTP 404'), { statusCode: 404 });
    vi.spyOn(pairing._transport, 'postJsonAuthed').mockRejectedValue(err);

    const result = await pairing.fetchProvisionCredential({
      agentId: 'claude_code',
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      pluginAuthToken: 'v1.tok',
    });

    expect(result).toBeNull();
  });
});
