import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/services/pairing.service', () => ({
  fetchCurrentPluginAuthToken: vi.fn(),
}));

import { fetchCurrentPluginAuthToken } from '../src/services/pairing.service';
import { IntegrationTokenClient, type BrokerCtx } from '../src/integrations/token-client';
import type { BrokeredIntegrationToken } from '@codeam/shared';

function makeCtx(overrides: Partial<BrokerCtx> = {}): BrokerCtx {
  return {
    sessionId: 'sess-1',
    pluginId: 'plugin-1',
    pluginAuthToken: 'initial-token',
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function tokenPayload(overrides: Partial<BrokeredIntegrationToken> = {}): {
  success: true;
  data: BrokeredIntegrationToken;
} {
  return {
    success: true,
    data: {
      accessToken: 'acc-tok',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1h out
      ...overrides,
    },
  };
}

describe('IntegrationTokenClient', () => {
  beforeEach(() => {
    vi.mocked(fetchCurrentPluginAuthToken).mockReset();
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('happy path: returns the token and caches it (second call within TTL does not re-fetch)', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse(200, tokenPayload()));
    const client = new IntegrationTokenClient(makeCtx(), fakeFetch as unknown as typeof fetch);

    const first = await client.getToken('jira');
    expect(first.accessToken).toBe('acc-tok');

    const second = await client.getToken('jira');
    expect(second).toEqual(first);

    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('re-fetches once the cached token is within the refresh-ahead window', async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, tokenPayload({ expiresAt: new Date(Date.now() + 1000).toISOString() })),
      )
      .mockResolvedValueOnce(jsonResponse(200, tokenPayload()));
    const client = new IntegrationTokenClient(makeCtx(), fakeFetch as unknown as typeof fetch);

    await client.getToken('jira');
    await client.getToken('jira');

    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it('401 retries once with a fresh token from fetchCurrentPluginAuthToken', async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { success: false }))
      .mockResolvedValueOnce(jsonResponse(200, tokenPayload()));
    vi.mocked(fetchCurrentPluginAuthToken).mockResolvedValue('fresh-token');

    const client = new IntegrationTokenClient(makeCtx(), fakeFetch as unknown as typeof fetch);
    const result = await client.getToken('jira');

    expect(result.accessToken).toBe('acc-tok');
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(fetchCurrentPluginAuthToken).toHaveBeenCalledWith('sess-1', 'plugin-1', undefined);

    const secondCallHeaders = fakeFetch.mock.calls[1][1].headers as Record<string, string>;
    expect(secondCallHeaders['X-Plugin-Auth-Token']).toBe('fresh-token');
  });

  it('403 INTEGRATION_NOT_IN_MANIFEST (after retry) throws with the code in the message', async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(403, { code: 'INTEGRATION_NOT_IN_MANIFEST' }))
      .mockResolvedValueOnce(jsonResponse(403, { code: 'INTEGRATION_NOT_IN_MANIFEST' }));
    vi.mocked(fetchCurrentPluginAuthToken).mockResolvedValue('fresh-token');

    const client = new IntegrationTokenClient(makeCtx(), fakeFetch as unknown as typeof fetch);

    await expect(client.getToken('jira')).rejects.toThrow(/INTEGRATION_NOT_IN_MANIFEST/);
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it('sends body {sessionId, pluginId} and the X-Plugin-Auth-Token header', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse(200, tokenPayload()));
    const ctx = makeCtx({ sessionId: 'sess-42', pluginId: 'plugin-42', pluginAuthToken: 'tok-42' });
    const client = new IntegrationTokenClient(ctx, fakeFetch as unknown as typeof fetch);

    await client.getToken('jira');

    const [, init] = fakeFetch.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ sessionId: 'sess-42', pluginId: 'plugin-42' });
    expect(init.headers['X-Plugin-Auth-Token']).toBe('tok-42');
  });
});
