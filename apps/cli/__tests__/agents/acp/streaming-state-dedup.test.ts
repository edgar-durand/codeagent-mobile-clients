import { describe, it, expect, vi } from 'vitest';
import { StreamingState } from '../../../src/agents/acp/runner';
import { reconcileCumulative } from '../../../src/agents/acp/reconcileDelta';
import { AcpPublisher } from '../../../src/agents/acp/publisher';

/**
 * Regression for the self-hosted (pair-auto) output-duplication bug.
 *
 * The house "CodeAgent Cloud" agent is `claude` over ACP. When pointed
 * at a self-hosted OpenAI-compatible proxy (ANTHROPIC_MODEL=MiniMax-M3),
 * the proxy ships CUMULATIVE message snapshots over SSE rather than true
 * incremental deltas; `claude-agent-acp` forwards each as an
 * `agent_message_chunk`. The old `this.text += delta.delta` then
 * concatenated the reply with itself on the chat pipe — the
 * "…hoy?¡Hola!…hoy?" intra-reply duplication. Real Anthropic Claude
 * sends true deltas, so `codeam pair` users never saw it.
 *
 * The fix derives the chat-bubble text from per-chunkId reconciled
 * buffers (snapshot → replace, delta → append), so the SAME runner is
 * correct for both adapter conventions.
 */

/** Last `content` posted to the chat pipe as a `type:'text'` event. */
function lastTextOutput(publishOutput: ReturnType<typeof vi.fn>): string | undefined {
  const calls = publishOutput.mock.calls
    .map((c) => c[0] as { type: string; content?: string })
    .filter((b) => b.type === 'text');
  return calls.length > 0 ? calls[calls.length - 1].content : undefined;
}

function makeState(): {
  state: StreamingState;
  publishOutput: ReturnType<typeof vi.fn>;
} {
  // Real publisher instance with its two network methods spied out — no
  // POST ever leaves the process, and StreamingState sees a correctly
  // typed AcpPublisher (no casts).
  const publisher = new AcpPublisher({
    sessionId: 'sess-1',
    pluginId: 'plugin-1',
    pluginAuthToken: 'tok-1',
    apiBaseUrl: 'https://api.example.test',
  });
  const publishOutput = vi.spyOn(publisher, 'publishOutput').mockResolvedValue(undefined);
  vi.spyOn(publisher, 'publishStreamingChunk').mockResolvedValue(undefined);
  return { state: new StreamingState(publisher), publishOutput };
}

describe('reconcileCumulative', () => {
  it('appends genuine deltas (disjoint segments)', () => {
    expect(reconcileCumulative('Hello', ', world')).toBe('Hello, world');
  });

  it('replaces with a growing cumulative snapshot', () => {
    expect(reconcileCumulative('¡Hola!', '¡Hola! ¿Cómo estás?')).toBe('¡Hola! ¿Cómo estás?');
  });

  it('is idempotent for an exact re-sent snapshot', () => {
    expect(reconcileCumulative('full reply', 'full reply')).toBe('full reply');
  });

  it('keeps the longer text when a stale/shorter snapshot arrives late', () => {
    expect(reconcileCumulative('full reply text', 'full reply')).toBe('full reply text');
  });

  it('treats the first chunk (empty existing) as a snapshot', () => {
    expect(reconcileCumulative('', 'first chunk')).toBe('first chunk');
  });

  it('does NOT append a prefix-drift snapshot (shared long prefix, divergent tail)', () => {
    // Real-Claude consolidated re-emit: shares the whole accumulated text but
    // diverges by a whitespace/segmentation difference near the end. Strict
    // startsWith misses it; without prefix-drift handling this APPENDed and
    // doubled the reply. We keep the shared prefix + the snapshot's net-new
    // tail — one reply, no doubling seam.
    const existing = 'The user said "Hola". Ill respond.';
    const incoming = 'The user said "Hola". I will respond.';
    const out = reconcileCumulative(existing, incoming);
    expect(out).toBe('The user said "Hola". I will respond.');
    expect(out).not.toContain('respond.The user'); // no append seam
  });

  it('still APPENDS a genuine delta that only coincidentally shares a few bytes', () => {
    // A short shared prefix (well under half of existing) is a real delta, not
    // a snapshot — must append, not collapse.
    expect(reconcileCumulative('The quick brown fox', ' jumps')).toBe(
      'The quick brown fox jumps',
    );
  });
});

describe('StreamingState.append — chat-pipe text reconciliation', () => {
  it('does NOT double a reply when the adapter sends cumulative snapshots', () => {
    const { state, publishOutput } = makeState();
    // MiniMax proxy shape: each agent_message_chunk is the FULL message
    // so far, all under one messageId (the chunkId).
    state.append({ chunkId: 'msg-1', kind: 'text', delta: '¡Hola! 👋' });
    state.append({ chunkId: 'msg-1', kind: 'text', delta: '¡Hola! 👋 ¿Cómo estás?' });
    state.append({
      chunkId: 'msg-1',
      kind: 'text',
      delta: '¡Hola! 👋 ¿Cómo estás? ¿En qué puedo ayudarte hoy?',
    });
    // Bug behaviour was the snapshots concatenated; the reply must equal
    // the final snapshot exactly — not "…hoy?¡Hola!…".
    expect(state.getCurrentText()).toBe(
      '¡Hola! 👋 ¿Cómo estás? ¿En qué puedo ayudarte hoy?',
    );
    expect(lastTextOutput(publishOutput)).toBe(
      '¡Hola! 👋 ¿Cómo estás? ¿En qué puedo ayudarte hoy?',
    );
  });

  it('still accumulates true incremental deltas (Anthropic Claude shape)', () => {
    const { state } = makeState();
    state.append({ chunkId: 'msg-1', kind: 'text', delta: 'The ' });
    state.append({ chunkId: 'msg-1', kind: 'text', delta: 'answer ' });
    state.append({ chunkId: 'msg-1', kind: 'text', delta: 'is 42.' });
    expect(state.getCurrentText()).toBe('The answer is 42.');
  });

  it('concatenates multiple distinct text chunks in arrival order', () => {
    const { state } = makeState();
    state.append({ chunkId: 'a', kind: 'text', delta: 'first.' });
    state.append({ chunkId: 'b', kind: 'text', delta: 'second.' });
    expect(state.getCurrentText()).toBe('first.second.');
  });

  it('ignores non-text chunks (thinking/tool) in the chat-bubble text', () => {
    const { state } = makeState();
    state.append({ chunkId: 't', kind: 'thinking', delta: 'pondering…' });
    state.append({ chunkId: 'msg-1', kind: 'text', delta: 'Done.' });
    expect(state.getCurrentText()).toBe('Done.');
  });

  it('does NOT replay a prior turn — beginTurn resets per-chunk state', async () => {
    const { state } = makeState();
    // Turn 1
    await state.beginTurn();
    state.append({ chunkId: 'msg-1', kind: 'text', delta: '¡Hola! greeting reply' });
    expect(state.getCurrentText()).toBe('¡Hola! greeting reply');
    await state.closeAll();

    // Turn 2 — a fresh prompt ("Estoy probando"). The new reply must
    // NOT carry the prior turn's greeting prepended to it.
    await state.beginTurn();
    state.append({ chunkId: 'msg-2', kind: 'text', delta: 'Genial, probemos.' });
    expect(state.getCurrentText()).toBe('Genial, probemos.');
  });
});
