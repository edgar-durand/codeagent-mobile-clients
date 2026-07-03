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

describe('AcpPublisher pairing-invalid (401/403 fatal)', () => {
  let postSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    postSpy = vi.spyOn(transport._transport, 'post');
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const stderrText = (): string => stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');

  function makePublisher(overrides: {
    refreshAuthToken?: () => Promise<string | null>;
    onPairingInvalid?: () => void;
  }): AcpPublisher {
    return new AcpPublisher({
      sessionId: 's1',
      pluginId: 'p1',
      pluginAuthToken: 'stale',
      apiBaseUrl: 'https://api.test',
      ...overrides,
    });
  }

  it('401 + refresh yields no token → latches: actionable message, no further posts', async () => {
    postSpy.mockResolvedValue({ statusCode: 401, body: 'INVALID_PLUGIN_TOKEN' });
    const refreshAuthToken = vi.fn().mockResolvedValue(null);
    const pub = makePublisher({ refreshAuthToken });

    await pub.publishOutput({ type: 'text', content: 'a', done: false });
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(stderrText()).toContain('codeam pair');

    // latched — none of the publisher surfaces post any more.
    await pub.publishOutput({ type: 'text', content: 'b', done: true });
    await pub.publishStreamingChunk({
      chunkId: 'c1',
      kind: 'text',
      content: 'x',
      isFinal: true,
    });
    await pub.publishAwaitingAnswer({ questionId: 'q', prompt: 'p', options: [] });
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(refreshAuthToken).toHaveBeenCalledTimes(1);
  });

  it('401 persisting after a successful refresh → latches (fresh token still rejected)', async () => {
    postSpy.mockResolvedValue({ statusCode: 401, body: 'INVALID_PLUGIN_TOKEN' });
    const refreshAuthToken = vi.fn().mockResolvedValue('fresh-token');
    const pub = makePublisher({ refreshAuthToken });

    await pub.publishOutput({ type: 'text', content: 'a', done: false });
    expect(postSpy).toHaveBeenCalledTimes(2); // original + one retry

    await pub.publishOutput({ type: 'text', content: 'b', done: true });
    expect(postSpy).toHaveBeenCalledTimes(2); // no more spam
  });

  it('the re-pair message is written ONCE across surfaces', async () => {
    postSpy.mockResolvedValue({ statusCode: 403, body: 'FORBIDDEN' });
    const pub = makePublisher({ refreshAuthToken: vi.fn().mockResolvedValue(null) });

    await pub.publishOutput({ type: 'text', content: 'a', done: false });
    await pub.publishOutput({ type: 'text', content: 'b', done: false });
    await pub.pushSessionList({ agentId: 'claude', sessions: [] });

    const mentions = stderrText().split('codeam pair').length - 1;
    expect(mentions).toBe(1);
  });

  it('fires onPairingInvalid exactly once', async () => {
    postSpy.mockResolvedValue({ statusCode: 401, body: 'INVALID_PLUGIN_TOKEN' });
    const onPairingInvalid = vi.fn();
    const pub = makePublisher({
      refreshAuthToken: vi.fn().mockResolvedValue(null),
      onPairingInvalid,
    });

    await pub.publishOutput({ type: 'text', content: 'a', done: false });
    await pub.publishOutput({ type: 'text', content: 'b', done: false });
    expect(onPairingInvalid).toHaveBeenCalledTimes(1);
  });

  it('successful refresh + 2xx retry does NOT latch (regression guard)', async () => {
    postSpy
      .mockResolvedValueOnce({ statusCode: 401, body: 'INVALID_PLUGIN_TOKEN' })
      .mockResolvedValue({ statusCode: 200, body: 'ok' });
    const pub = makePublisher({ refreshAuthToken: vi.fn().mockResolvedValue('fresh') });

    await pub.publishOutput({ type: 'text', content: 'a', done: false });
    await pub.publishOutput({ type: 'text', content: 'b', done: true });
    expect(postSpy).toHaveBeenCalledTimes(3); // 401 + retry + next post
    expect(stderrText()).not.toContain('codeam pair');
  });

  it('5xx / transient errors do NOT latch', async () => {
    postSpy.mockResolvedValue({ statusCode: 503, body: 'unavailable' });
    const pub = makePublisher({ refreshAuthToken: vi.fn().mockResolvedValue(null) });

    await pub.publishOutput({ type: 'text', content: 'a', done: false });
    await pub.publishOutput({ type: 'text', content: 'b', done: false });
    expect(postSpy).toHaveBeenCalledTimes(2);
    expect(stderrText()).not.toContain('codeam pair');
  });
});
