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
