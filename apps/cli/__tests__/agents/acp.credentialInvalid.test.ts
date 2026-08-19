import { describe, it, expect, vi } from 'vitest';
import { reportCredentialInvalid } from '../../src/agents/acp/runner';

vi.mock('../../src/services/pairing.service', () => ({
  fetchCurrentPluginAuthToken: vi.fn(),
  _postJsonAuthed: vi.fn(),
}));

import { fetchCurrentPluginAuthToken } from '../../src/services/pairing.service';

describe('reportCredentialInvalid', () => {
  it('POSTs to the credential-invalid endpoint with the plugin-auth header + body', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;

    await reportCredentialInvalid(
      { agent: 'claude_code', sessionId: 's1', pluginId: 'p1', pluginAuthToken: 'tok' },
      fakeFetch,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/api\/plugin\/agents\/claude_code\/credential-invalid$/);
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['X-Plugin-Auth-Token']).toBe('tok');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ sessionId: 's1', pluginId: 'p1' });
  });

  it('never throws even if fetch rejects (best-effort)', async () => {
    const fakeFetch = vi.fn(async () => { throw new Error('network'); }) as unknown as typeof fetch;
    await expect(
      reportCredentialInvalid({ agent: 'a', sessionId: 's', pluginId: 'p', pluginAuthToken: 't' }, fakeFetch),
    ).resolves.toBeUndefined();
  });

  it('carries the optional reason on the wire when given', async () => {
    const calls: Array<{ init: RequestInit }> = [];
    const fakeFetch = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push({ init });
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;

    await reportCredentialInvalid(
      { agent: 'gemini', sessionId: 's1', pluginId: 'p1', pluginAuthToken: 'tok', reason: 'ineligible_tier' },
      fakeFetch,
    );

    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      sessionId: 's1',
      pluginId: 'p1',
      reason: 'ineligible_tier',
    });
  });

  it('OMITS reason entirely when absent (byte-identical to the pre-reason wire)', async () => {
    const calls: Array<{ init: RequestInit }> = [];
    const fakeFetch = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push({ init });
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;

    await reportCredentialInvalid(
      { agent: 'claude_code', sessionId: 's1', pluginId: 'p1', pluginAuthToken: 'tok' },
      fakeFetch,
    );

    expect(calls[0].init.body).toBe(JSON.stringify({ sessionId: 's1', pluginId: 'p1' }));
  });

  it('url-encodes the agent id', async () => {
    const calls: string[] = [];
    const fakeFetch = vi.fn(async (url: string) => { calls.push(url); return { ok: true, status: 200 } as Response; }) as unknown as typeof fetch;
    await reportCredentialInvalid({ agent: 'claude code', sessionId: 's', pluginId: 'p', pluginAuthToken: 't' }, fakeFetch);
    expect(calls[0]).toMatch(/\/agents\/claude%20code\/credential-invalid$/);
  });

  it('retries with fresh token when first POST returns 401', async () => {
    const mockedRefresh = vi.mocked(fetchCurrentPluginAuthToken);
    mockedRefresh.mockResolvedValueOnce('fresh-token');

    let callCount = 0;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      callCount += 1;
      return { ok: false, status: callCount === 1 ? 401 : 200 } as Response;
    }) as unknown as typeof fetch;

    await reportCredentialInvalid(
      { agent: 'claude_code', sessionId: 's1', pluginId: 'p1', pluginAuthToken: 'old-token', pollSecret: 'poll-secret' },
      fakeFetch,
    );

    expect(mockedRefresh).toHaveBeenCalledOnce();
    expect(mockedRefresh).toHaveBeenCalledWith('s1', 'p1', 'poll-secret');
    expect(fakeFetch).toHaveBeenCalledTimes(2);

    // Second call must use the fresh token
    const secondHeaders = calls[1].init.headers as Record<string, string>;
    expect(secondHeaders['X-Plugin-Auth-Token']).toBe('fresh-token');

    // Both calls must target the same URL with the same body
    expect(calls[0].url).toBe(calls[1].url);
    expect(calls[0].url).toMatch(/\/api\/plugin\/agents\/claude_code\/credential-invalid$/);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ sessionId: 's1', pluginId: 'p1' });
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ sessionId: 's1', pluginId: 'p1' });
  });

  it('does not retry when first POST returns 2xx', async () => {
    const mockedRefresh = vi.mocked(fetchCurrentPluginAuthToken);
    mockedRefresh.mockReset();

    const fakeFetch = vi.fn(async () => ({ ok: true, status: 200 }) as Response) as unknown as typeof fetch;

    await reportCredentialInvalid(
      { agent: 'claude_code', sessionId: 's1', pluginId: 'p1', pluginAuthToken: 'tok' },
      fakeFetch,
    );

    expect(mockedRefresh).not.toHaveBeenCalled();
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry when refresh returns null', async () => {
    const mockedRefresh = vi.mocked(fetchCurrentPluginAuthToken);
    mockedRefresh.mockResolvedValueOnce(null);

    const fakeFetch = vi.fn(async () => ({ ok: false, status: 401 }) as Response) as unknown as typeof fetch;

    await reportCredentialInvalid(
      { agent: 'claude_code', sessionId: 's1', pluginId: 'p1', pluginAuthToken: 'old-token' },
      fakeFetch,
    );

    expect(mockedRefresh).toHaveBeenCalledOnce();
    expect(mockedRefresh).toHaveBeenCalledWith('s1', 'p1', undefined);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });
});
