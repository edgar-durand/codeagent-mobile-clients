/**
 * codeagent-gsk1 — the chat pipe (`/api/commands/output`) must not get one
 * POST per adapter delta. Each `text` frame carries the CUMULATIVE reply, so
 * per-delta publishing was ~one frame per 8 characters (7,724 frames for one
 * 64 KB reply in the 2026-08-22 Redis OOM). The non-final frame is throttled
 * to one per CHAT_TEXT_PUBLISH_INTERVAL_MS; the terminal `done:true` frame is
 * immediate, carries the full text, and nothing partial lands after it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AcpPublisher } from '../../../src/agents/acp/publisher';
import {
  StreamingState,
  CHAT_TEXT_PUBLISH_INTERVAL_MS,
  CHAT_TEXT_PUBLISH_CHARS_PER_SEC,
} from '../../../src/agents/acp/runner';

type OutputBody = { type: string; content?: string; done?: boolean };

function makeState() {
  const publisher = new AcpPublisher({
    sessionId: 'sess-throttle',
    pluginId: 'plugin-throttle',
    pluginAuthToken: 'tok',
    apiBaseUrl: 'https://api.example.test',
  });
  const publishOutput = vi.spyOn(publisher, 'publishOutput').mockResolvedValue(undefined);
  vi.spyOn(publisher, 'publishStreamingChunk').mockResolvedValue(undefined);
  const textFrames = (): OutputBody[] =>
    publishOutput.mock.calls.map((c) => c[0] as OutputBody).filter((b) => b.type === 'text');
  return { state: new StreamingState(publisher), textFrames };
}

describe('StreamingState chat-pipe text throttle (codeagent-gsk1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('500 deltas over 1 s yield ~10 partial frames, and done:true carries the full text exactly once, last', async () => {
    const { state, textFrames } = makeState();
    await state.beginTurn();
    let expected = '';
    for (let i = 0; i < 500; i += 1) {
      const delta = `w${i} `;
      expected += delta;
      state.append({ chunkId: 'msg-1', kind: 'text', delta });
      await vi.advanceTimersByTimeAsync(2); // 500 × 2 ms = 1 s of streaming
    }
    const partials = textFrames().filter((f) => f.done === false);
    expect(partials.length).toBeLessThanOrEqual(1000 / CHAT_TEXT_PUBLISH_INTERVAL_MS + 2);
    expect(partials.length).toBeGreaterThanOrEqual(5);

    await state.closeAll();
    // A trailing timer must not fire a stale partial after the terminal frame.
    await vi.advanceTimersByTimeAsync(CHAT_TEXT_PUBLISH_INTERVAL_MS * 3);
    const frames = textFrames();
    const finals = frames.filter((f) => f.done === true);
    expect(finals).toHaveLength(1);
    expect(frames.at(-1)).toEqual({ type: 'text', content: expected, done: true });
  });

  it('a long reply stretches the interval so the upload rate stays bounded (2026-10-09 p99 incident)', async () => {
    const { state, textFrames } = makeState();
    await state.beginTurn();
    // ~200 KB already streamed, then 10 s more of deltas: the incident's shape
    // (cumulative ~200 KB frames re-posted ~3×/s for 40 min).
    state.append({ chunkId: 'msg-1', kind: 'text', delta: 'x'.repeat(200_000) });
    for (let i = 0; i < 1000; i += 1) {
      state.append({ chunkId: 'msg-1', kind: 'text', delta: 'yy' });
      await vi.advanceTimersByTimeAsync(10); // 1000 × 10 ms = 10 s
    }
    const partials = textFrames().filter((f) => f.done === false);
    const sentChars = partials.reduce((n, f) => n + (f.content?.length ?? 0), 0);
    // Without the stretch: ~100 frames × 200 KB = ~20 MB in 10 s.
    expect(sentChars).toBeLessThanOrEqual(CHAT_TEXT_PUBLISH_CHARS_PER_SEC * 10 + 210_000);
    expect(partials.length).toBeGreaterThanOrEqual(2);

    await state.closeAll();
    const frames = textFrames();
    expect(frames.at(-1)?.done).toBe(true);
    expect(frames.at(-1)?.content?.length).toBe(202_000);
  });

  it('the first delta after a quiet window publishes immediately (no added first-token latency)', async () => {
    const { state, textFrames } = makeState();
    await state.beginTurn();
    state.append({ chunkId: 'msg-1', kind: 'text', delta: 'Hello' });
    expect(textFrames()).toEqual([{ type: 'text', content: 'Hello', done: false }]);
  });

  it('a burst inside one window collapses into ONE trailing frame with the latest cumulative text', async () => {
    const { state, textFrames } = makeState();
    await state.beginTurn();
    state.append({ chunkId: 'msg-1', kind: 'text', delta: 'Hello' }); // immediate
    state.append({ chunkId: 'msg-1', kind: 'text', delta: ', wor' });
    state.append({ chunkId: 'msg-1', kind: 'text', delta: 'ld' });
    expect(textFrames()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(CHAT_TEXT_PUBLISH_INTERVAL_MS);
    expect(textFrames()).toEqual([
      { type: 'text', content: 'Hello', done: false },
      { type: 'text', content: 'Hello, world', done: false },
    ]);
  });

  it('closeWithBubble and closeTurnWithInteractiveDetection also cancel a pending partial', async () => {
    for (const close of ['bubble', 'interactive'] as const) {
      const { state, textFrames } = makeState();
      await state.beginTurn();
      state.append({ chunkId: 'msg-1', kind: 'text', delta: 'raw ' });
      state.append({ chunkId: 'msg-1', kind: 'text', delta: 'error text' }); // pending
      if (close === 'bubble') await state.closeWithBubble('Please re-link.');
      else await state.closeTurnWithInteractiveDetection();
      await vi.advanceTimersByTimeAsync(CHAT_TEXT_PUBLISH_INTERVAL_MS * 3);
      const frames = textFrames();
      expect(frames.at(-1)?.done).toBe(true);
      expect(frames.filter((f) => f.done === false)).toHaveLength(1);
    }
  });

  it('a new turn starts with an immediate frame even right after the previous turn', async () => {
    const { state, textFrames } = makeState();
    await state.beginTurn();
    state.append({ chunkId: 'a', kind: 'text', delta: 'one' });
    await state.closeAll();
    await state.beginTurn();
    state.append({ chunkId: 'b', kind: 'text', delta: 'two' });
    expect(textFrames().at(-1)).toEqual({ type: 'text', content: 'two', done: false });
  });
});
