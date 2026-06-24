/**
 * Tests for the ACP HTTP publisher.
 *
 * Stubs the underlying `_transport` to drive every code path
 * without standing up an HTTP server. The publisher's contract is
 * "fire-and-forget on failure" — these tests verify error paths
 * don't throw + happy paths post the right URL / body.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpPublisher } from '../../src/agents/acp/publisher';
import * as transport from '../../src/services/streaming/transport';

const apiBaseUrl = 'https://example.test';

describe('AcpPublisher', () => {
  let publisher: AcpPublisher;
  let postSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    publisher = new AcpPublisher({
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      pluginAuthToken: 'tok-1',
      apiBaseUrl,
    });
    postSpy = vi.spyOn(transport._transport, 'post').mockResolvedValue({
      statusCode: 202,
      body: '',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('publishOutput POSTs to the legacy chat pipe with the body envelope', async () => {
    await publisher.publishOutput({ type: 'text', content: 'hello', done: false });
    expect(postSpy).toHaveBeenCalledTimes(1);
    const [url, headers, payload] = postSpy.mock.calls[0];
    expect(url).toBe(`${apiBaseUrl}/api/commands/output`);
    expect(headers['X-Plugin-Auth-Token']).toBe('tok-1');
    // sessionId + pluginId in the BODY — the backend's PluginAuthGuard
    // rejects with PLUGIN_TOKEN_REQUIRED otherwise even when
    // X-Plugin-Auth-Token is set on the header.
    expect(JSON.parse(payload)).toEqual({
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      type: 'text',
      content: 'hello',
      done: false,
    });
  });

  it('publishOutput boundary events (clear / new_turn) hit the same endpoint', async () => {
    await publisher.publishOutput({ type: 'clear' });
    await publisher.publishOutput({ type: 'new_turn', done: false });
    expect(postSpy).toHaveBeenCalledTimes(2);
    for (const call of postSpy.mock.calls) {
      expect(call[0]).toBe(`${apiBaseUrl}/api/commands/output`);
    }
    expect(JSON.parse(postSpy.mock.calls[0][2])).toEqual({
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      type: 'clear',
    });
    expect(JSON.parse(postSpy.mock.calls[1][2])).toEqual({
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      type: 'new_turn',
      done: false,
    });
  });

  it('publishAwaitingAnswer hits the awaiting-answer endpoint', async () => {
    await publisher.publishAwaitingAnswer({
      questionId: 'q-1',
      prompt: 'Run rm?',
      options: ['Yes', 'No'],
    });
    expect(postSpy).toHaveBeenCalledTimes(1);
    const [url] = postSpy.mock.calls[0];
    expect(url).toBe(`${apiBaseUrl}/api/sessions/sess-1/awaiting-answer`);
  });

  it('output POST that throws never surfaces — fire-and-forget guarantee', async () => {
    postSpy.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(
      publisher.publishOutput({ type: 'text', content: 'hi', done: true }),
    ).resolves.toBeUndefined();
  });
});

describe('AcpPublisher reauth-on-401', () => {
  let postSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    postSpy = vi.spyOn(transport._transport, 'post');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refreshes the token and retries once when output POST returns 401', async () => {
    postSpy
      .mockResolvedValueOnce({ statusCode: 401, body: 'INVALID_PLUGIN_TOKEN' })
      .mockResolvedValueOnce({ statusCode: 200, body: 'ok' });
    const refreshAuthToken = vi.fn().mockResolvedValue('fresh-token-xyz');

    const pub = new AcpPublisher({
      sessionId: 's1',
      pluginId: 'p1',
      pluginAuthToken: 'stale-token',
      apiBaseUrl: 'https://api.test',
      refreshAuthToken,
    });

    await pub.publishOutput({ type: 'text', content: 'hi', done: true });

    expect(refreshAuthToken).toHaveBeenCalledTimes(1);
    expect(postSpy).toHaveBeenCalledTimes(2);
    // First attempt used the stale token, retry used the fresh one.
    expect(postSpy.mock.calls[0][1]['X-Plugin-Auth-Token']).toBe('stale-token');
    expect(postSpy.mock.calls[1][1]['X-Plugin-Auth-Token']).toBe('fresh-token-xyz');
  });

  it('does not retry when no refreshAuthToken is provided', async () => {
    postSpy.mockResolvedValueOnce({ statusCode: 401, body: 'INVALID_PLUGIN_TOKEN' });

    const pub = new AcpPublisher({
      sessionId: 's1',
      pluginId: 'p1',
      pluginAuthToken: 'stale-token',
      apiBaseUrl: 'https://api.test',
    });

    await pub.publishOutput({ type: 'text', content: 'hi', done: true });
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it('does not refresh on a 2xx', async () => {
    postSpy.mockResolvedValueOnce({ statusCode: 200, body: 'ok' });
    const refreshAuthToken = vi.fn().mockResolvedValue('fresh');

    const pub = new AcpPublisher({
      sessionId: 's1',
      pluginId: 'p1',
      pluginAuthToken: 't',
      apiBaseUrl: 'https://api.test',
      refreshAuthToken,
    });

    await pub.publishOutput({ type: 'text', content: 'hi', done: true });
    expect(refreshAuthToken).not.toHaveBeenCalled();
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it('does not retry when refresh returns null (no token available)', async () => {
    postSpy.mockResolvedValueOnce({ statusCode: 401, body: 'INVALID_PLUGIN_TOKEN' });
    const refreshAuthToken = vi.fn().mockResolvedValue(null);

    const pub = new AcpPublisher({
      sessionId: 's1',
      pluginId: 'p1',
      pluginAuthToken: 'stale',
      apiBaseUrl: 'https://api.test',
      refreshAuthToken,
    });

    await pub.publishOutput({ type: 'text', content: 'hi', done: true });
    expect(refreshAuthToken).toHaveBeenCalledTimes(1);
    expect(postSpy).toHaveBeenCalledTimes(1);
  });
});
