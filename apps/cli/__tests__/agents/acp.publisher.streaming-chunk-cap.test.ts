import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AcpPublisher,
  STREAMING_CHUNK_COALESCE_WINDOW_MS,
  STREAMING_CHUNK_SNAPSHOT_MAX_CHARS,
  boundStreamingChunkContent,
} from '../../src/agents/acp/publisher';
import * as transport from '../../src/services/streaming/transport';

/**
 * 2026-09-23: two codespace sessions produced 54,718 × 400 on
 * POST /api/sessions/:id/streaming-chunk in one day — a tool result grew past
 * api-v2's 64 KiB `content` cap and the cumulative snapshot was re-sent, and
 * rejected, on EVERY following delta (128 KB bodies at ~11/s). The publisher
 * must (1) never send a body over the cap, (2) stop re-sending a truncated
 * chunk until its terminal frame, (3) coalesce big-chunk snapshots.
 */
describe('AcpPublisher — streaming-chunk snapshot cap', () => {
  let publisher: AcpPublisher;
  let postSpy: ReturnType<typeof vi.spyOn>;
  const payloads = () =>
    (postSpy.mock.calls as unknown[][]).map(
      (c) => JSON.parse(String(c[2])) as { chunkId: string; content: string; isFinal: boolean },
    );

  beforeEach(() => {
    vi.useFakeTimers();
    publisher = new AcpPublisher({
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      pluginAuthToken: 'tok-1',
      apiBaseUrl: 'https://example.test',
    });
    postSpy = vi
      .spyOn(transport._transport, 'post')
      .mockResolvedValue({ statusCode: 202, body: '' });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('boundStreamingChunkContent keeps the head and says how much was dropped', () => {
    const big = 'x'.repeat(STREAMING_CHUNK_SNAPSHOT_MAX_CHARS + 1000);
    const out = boundStreamingChunkContent(big);
    expect(out.truncated).toBe(true);
    expect(out.content.startsWith('x'.repeat(STREAMING_CHUNK_SNAPSHOT_MAX_CHARS))).toBe(true);
    expect(out.content).toContain('1000 more characters');
    expect(out.content.length).toBeLessThan(64 * 1024);
    expect(boundStreamingChunkContent('small')).toEqual({ content: 'small', truncated: false });
  });

  it('a chunk past the cap is sent truncated ONCE, then only its terminal frame', async () => {
    const over = 'y'.repeat(STREAMING_CHUNK_SNAPSHOT_MAX_CHARS + 5000);
    await publisher.publishStreamingChunk({
      chunkId: 'c1',
      kind: 'tool_result',
      content: over,
      isFinal: false,
    });
    await publisher.publishStreamingChunk({
      chunkId: 'c1',
      kind: 'tool_result',
      content: over + 'more',
      isFinal: false,
    });
    await publisher.publishStreamingChunk({
      chunkId: 'c1',
      kind: 'tool_result',
      content: over + 'moremore',
      isFinal: false,
    });
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(payloads()[0].content.length).toBeLessThan(64 * 1024);
    expect(payloads()[0].content).toContain('output truncated');
    await publisher.publishStreamingChunk({
      chunkId: 'c1',
      kind: 'tool_result',
      content: over + 'end',
      isFinal: true,
    });
    expect(postSpy).toHaveBeenCalledTimes(2);
    expect(payloads()[1].isFinal).toBe(true);
    expect(payloads()[1].content.length).toBeLessThan(64 * 1024);
  });

  it('small snapshots go out on every delta (no behavior change below 8 KB)', async () => {
    for (let i = 0; i < 5; i++) {
      await publisher.publishStreamingChunk({
        chunkId: 'c2',
        kind: 'text',
        content: 'a'.repeat(100 * (i + 1)),
        isFinal: false,
      });
    }
    expect(postSpy).toHaveBeenCalledTimes(5);
  });

  it('big snapshots are coalesced to one trailing POST per window, latest content wins; final flushes immediately', async () => {
    const base = 'z'.repeat(20 * 1024);
    await publisher.publishStreamingChunk({
      chunkId: 'c3',
      kind: 'thinking',
      content: base,
      isFinal: false,
    });
    expect(postSpy).toHaveBeenCalledTimes(1); // first one goes straight out
    await publisher.publishStreamingChunk({
      chunkId: 'c3',
      kind: 'thinking',
      content: base + '1',
      isFinal: false,
    });
    await publisher.publishStreamingChunk({
      chunkId: 'c3',
      kind: 'thinking',
      content: base + '12',
      isFinal: false,
    });
    expect(postSpy).toHaveBeenCalledTimes(1); // both within the window → pending
    await vi.advanceTimersByTimeAsync(STREAMING_CHUNK_COALESCE_WINDOW_MS + 5);
    expect(postSpy).toHaveBeenCalledTimes(2);
    expect(payloads()[1].content.endsWith('12')).toBe(true); // latest snapshot, not the first pending one
    await publisher.publishStreamingChunk({
      chunkId: 'c3',
      kind: 'thinking',
      content: base + '123',
      isFinal: false,
    });
    await publisher.publishStreamingChunk({
      chunkId: 'c3',
      kind: 'thinking',
      content: base + '123',
      isFinal: true,
    });
    expect(postSpy).toHaveBeenCalledTimes(3); // the pending one was superseded by the terminal frame
    expect(payloads()[2].isFinal).toBe(true);
  });
});
