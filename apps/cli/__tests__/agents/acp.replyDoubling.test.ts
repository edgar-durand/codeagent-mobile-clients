/**
 * Regression test for the doubled-reply bug — driven through the REAL
 * StreamingState (beginTurn → append → closeAll), NOT a pure helper.
 *
 * The earlier `reconcileCumulative` unit test passed while the live flow
 * still doubled, because the doubling is CROSS-chunk: `claude-agent-acp`
 * (≥0.47) streams the reply as `agent_message_chunk` deltas under one
 * message id, then — when its own streamed-vs-consolidated dedupe misfires
 * (live path keys `streamedTextIds` off the stream message id, while
 * consolidation checks `messageIdForGrouping`, which differs for some
 * gateways) — RE-EMITS the complete assistant message as a fresh
 * `agent_message_chunk` under a DIFFERENT message id. Two ids → two
 * buffers → `recomputeText` concatenates → the whole reply doubles. Seen
 * on both real Claude (codespace) and the MiniMax proxy (self-hosted).
 *
 * These tests reproduce that exact wire sequence and assert the final
 * `done:true` chat text is the reply EXACTLY ONCE. They FAIL against the
 * pre-fix code (per-adapter-chunkId buffers) and PASS once every text
 * segment of a turn collapses onto one reconcile buffer.
 */

import { describe, expect, it, vi } from 'vitest';
import { StreamingState } from '../../src/agents/acp/runner';
import type { AcpPublisher } from '../../src/agents/acp/publisher';

interface OutEvent {
  type: string;
  content?: string;
  done?: boolean;
}

function buildHarness() {
  const out: OutEvent[] = [];
  const publisher = {
    publishOutput: vi.fn(async (e: OutEvent) => {
      out.push(e);
    }),
    publishStreamingChunk: vi.fn(async () => {}),
  } as unknown as AcpPublisher;
  const state = new StreamingState(publisher);
  return { state, out };
}

/** The final `done:true` chat-bubble text the user actually sees. */
function finalText(out: OutEvent[]): string {
  const done = out.filter((e) => e.type === 'text' && e.done === true);
  return done[done.length - 1]?.content ?? '';
}

const REPLY =
  '¡Perfecto! Estoy listo cuando necesites ayuda. 🛠️ Solo dime en qué puedo asistirte.';

describe('StreamingState — reply must never double across adapter chunk ids', () => {
  it('Claude live deltas (msg-A) + consolidated full re-emit (msg-B) → reply once', async () => {
    const { state, out } = buildHarness();
    await state.beginTurn({ clear: false });

    // 1) Live streaming: true deltas under the stream message id.
    const head = '¡Perfecto! Estoy listo cuando necesites ayuda. 🛠️ ';
    const tail = 'Solo dime en qué puedo asistirte.';
    state.append({ chunkId: 'msg-A', kind: 'text', delta: head });
    state.append({ chunkId: 'msg-A', kind: 'text', delta: tail });

    // 2) Adapter re-emits the CONSOLIDATED full message under a DIFFERENT
    //    id because its internal dedupe missed the live stream.
    state.append({ chunkId: 'msg-B', kind: 'text', delta: REPLY });

    await state.closeAll();

    expect(finalText(out)).toBe(REPLY);
    // And specifically NOT the doubled string the bug produced.
    expect(finalText(out)).not.toBe(REPLY + REPLY);
  });

  it('MiniMax cumulative snapshots under rotating random ids → reply once', async () => {
    const { state, out } = buildHarness();
    await state.beginTurn({ clear: false });

    // The self-hosted proxy ships growing FULL snapshots, and the adapter
    // forwards each under a fresh id (no stable messageId → random uuid).
    state.append({ chunkId: 'id-1', kind: 'text', delta: '¡Hola! 👋 ' });
    state.append({ chunkId: 'id-2', kind: 'text', delta: '¡Hola! 👋 ¿En qué ' });
    state.append({ chunkId: 'id-3', kind: 'text', delta: '¡Hola! 👋 ¿En qué puedo ayudarte hoy?' });

    await state.closeAll();

    expect(finalText(out)).toBe('¡Hola! 👋 ¿En qué puedo ayudarte hoy?');
  });

  it('a genuinely new turn resets — replies do not bleed across turns', async () => {
    const { state, out } = buildHarness();

    await state.beginTurn({ clear: false });
    state.append({ chunkId: 'm1', kind: 'text', delta: 'First answer.' });
    await state.closeAll();
    expect(finalText(out)).toBe('First answer.');

    await state.beginTurn({ clear: false });
    state.append({ chunkId: 'm2', kind: 'text', delta: 'Second answer.' });
    await state.closeAll();
    expect(finalText(out)).toBe('Second answer.');
  });
});
