import { describe, it, expect, vi } from 'vitest';
import { reportCredentialInvalid } from '../../src/agents/acp/runner';

describe('reportCredentialInvalid', () => {
  it('POSTs to the credential-invalid endpoint with the plugin-auth header + body', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true } as Response;
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

  it('url-encodes the agent id', async () => {
    const calls: string[] = [];
    const fakeFetch = vi.fn(async (url: string) => { calls.push(url); return { ok: true } as Response; }) as unknown as typeof fetch;
    await reportCredentialInvalid({ agent: 'claude code', sessionId: 's', pluginId: 'p', pluginAuthToken: 't' }, fakeFetch);
    expect(calls[0]).toMatch(/\/agents\/claude%20code\/credential-invalid$/);
  });
});
