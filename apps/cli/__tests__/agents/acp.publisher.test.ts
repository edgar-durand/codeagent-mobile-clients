/**
 * Tests for the ACP HTTP publisher.
 *
 * Stubs the underlying `_transport` to drive every code path
 * without standing up an HTTP server. The publisher's contract is
 * "fire-and-forget on failure" — these tests verify error paths
 * don't throw + happy paths post the right URL / body.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpPublisher, parsePendingAnswerResponse } from '../../src/agents/acp/publisher';
import * as transport from '../../src/services/streaming/transport';

const apiBaseUrl = 'https://example.test';

describe('AcpPublisher', () => {
  let publisher: AcpPublisher;
  let postSpy: ReturnType<typeof vi.spyOn>;
  let getSpy: ReturnType<typeof vi.spyOn>;

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
    getSpy = vi.spyOn(transport._transport, 'get').mockResolvedValue({
      statusCode: 204,
      body: '',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('publishChunk POSTs the JSON body to the right URL with auth headers', async () => {
    await publisher.publishChunk({
      chunkId: 'c-1',
      kind: 'text',
      content: 'hello',
      isFinal: true,
    });
    expect(postSpy).toHaveBeenCalledTimes(1);
    const [url, headers, payload] = postSpy.mock.calls[0];
    expect(url).toBe(`${apiBaseUrl}/api/sessions/sess-1/streaming-chunk`);
    expect(headers['X-Plugin-Auth-Token']).toBe('tok-1');
    expect(JSON.parse(payload)).toEqual({
      chunkId: 'c-1',
      kind: 'text',
      content: 'hello',
      isFinal: true,
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

  it('pollPendingAnswer returns null on 204 (no reply yet)', async () => {
    const result = await publisher.pollPendingAnswer('q-1');
    expect(result).toBeNull();
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it('pollPendingAnswer parses { data: {...} } envelope', async () => {
    getSpy.mockResolvedValueOnce({
      statusCode: 200,
      body: JSON.stringify({ data: { questionId: 'q-1', answer: 'Yes', optionIndex: 0 } }),
    });
    const result = await publisher.pollPendingAnswer('q-1');
    expect(result).toEqual({ questionId: 'q-1', answer: 'Yes', optionIndex: 0 });
  });

  it('pollPendingAnswer accepts bare shape (no envelope)', async () => {
    getSpy.mockResolvedValueOnce({
      statusCode: 200,
      body: JSON.stringify({ questionId: 'q-1', answer: 'No' }),
    });
    const result = await publisher.pollPendingAnswer('q-1');
    expect(result).toEqual({ questionId: 'q-1', answer: 'No' });
  });

  it('pollPendingAnswer ignores replies for a different questionId', async () => {
    getSpy.mockResolvedValueOnce({
      statusCode: 200,
      body: JSON.stringify({ questionId: 'q-OTHER', answer: 'Yes' }),
    });
    const result = await publisher.pollPendingAnswer('q-1');
    expect(result).toBeNull();
  });

  it('chunk POST that throws never surfaces — fire-and-forget guarantee', async () => {
    postSpy.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(
      publisher.publishChunk({
        chunkId: 'c-1',
        kind: 'text',
        content: 'hi',
        isFinal: true,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('parsePendingAnswerResponse (exported helper)', () => {
  it('returns null for malformed JSON', () => {
    expect(parsePendingAnswerResponse('not-json', 'q-1')).toBeNull();
  });
  it('returns null when answer is missing', () => {
    expect(
      parsePendingAnswerResponse(JSON.stringify({ questionId: 'q-1' }), 'q-1'),
    ).toBeNull();
  });
  it('preserves optionIndex when integer, drops when not', () => {
    expect(
      parsePendingAnswerResponse(
        JSON.stringify({ questionId: 'q-1', answer: 'Yes', optionIndex: 1.5 }),
        'q-1',
      ),
    ).toEqual({ questionId: 'q-1', answer: 'Yes' });
  });
});
