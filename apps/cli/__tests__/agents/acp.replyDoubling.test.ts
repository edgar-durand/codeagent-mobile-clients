/**
 * Integration regression for the doubled-reply bug — driven end to end
 * through the REAL ACP path: raw `agent_message_chunk` SessionNotifications
 * → `mapSessionUpdate` (the actual mapper) → `StreamingState.append` /
 * `closeAll` (the actual runner) → the chat text the user sees. No pure
 * helper in isolation; this is the same chain `runAcpSession` runs.
 *
 * The wire below is COPIED FROM A LIVE self-hosted box's debug log for a
 * "Hola" turn (claude-agent-acp ≥0.47):
 *
 *   #15 agent_message_chunk  text:"¡Hola!"                       (delta)
 *   #16 agent_message_chunk  text:" 👋 ¿En qué puedo ayudarte hoy?" (delta)
 *   #17 agent_message_chunk  text:"¡Hola! 👋 ¿En qué puedo ayudarte hoy?" (FULL re-emit)
 *
 * #17 is the adapter re-emitting the CONSOLIDATED message under a different
 * message id after its own streamed-vs-consolidated dedupe misfires. With a
 * per-adapter-chunkId buffer the two ids land in two buffers and the bubble
 * text doubles ("…hoy?¡Hola!…hoy?") — exactly what shipped to the apps.
 *
 * REGRESSION PROOF: this test FAILS against the per-chunkId buffering (the
 * pre-fix runner) and PASSES once every text segment of a turn collapses
 * onto one reconcile buffer. (Verified by reverting the fix → 2 failures.)
 */

import { describe, expect, it, vi } from 'vitest';
import { StreamingState } from '../../src/agents/acp/runner';
import { mapSessionUpdate } from '../../src/agents/acp/mappers';
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
  return { state: new StreamingState(publisher), out };
}

/** A real ACP `agent_message_chunk` notification (text content block). */
function textChunk(messageId: string | null, text: string) {
  return {
    sessionId: 'sess-1',
    update: {
      sessionUpdate: 'agent_message_chunk',
      messageId,
      content: { type: 'text', text },
    },
    // cast at the test boundary: we construct the exact wire shape the SDK
    // delivers; the mapper only reads update.sessionUpdate/messageId/content.
  } as unknown as Parameters<typeof mapSessionUpdate>[0];
}

/** Replay a list of notifications through the real mapper + runner. */
async function runTurn(
  state: StreamingState,
  notes: ReturnType<typeof textChunk>[],
): Promise<void> {
  await state.beginTurn({ clear: false });
  for (const note of notes) {
    for (const delta of mapSessionUpdate(note)) state.append(delta);
  }
  await state.closeAll();
}

/** The final `done:true` chat-bubble text the user actually sees. */
function finalText(out: OutEvent[]): string {
  const done = out.filter((e) => e.type === 'text' && e.done === true);
  return done[done.length - 1]?.content ?? '';
}

describe('ACP reply must not double (integration: notification → mapper → runner)', () => {
  it('streamed deltas + consolidated full re-emit under a 2nd message id → reply once', async () => {
    const { state, out } = buildHarness();
    // Exact captured wire: two stream deltas (id A), then the full message
    // re-emitted under id B.
    await runTurn(state, [
      textChunk('msg-A', '¡Hola!'),
      textChunk('msg-A', ' 👋 ¿En qué puedo ayudarte hoy?'),
      textChunk('msg-B', '¡Hola! 👋 ¿En qué puedo ayudarte hoy?'),
    ]);

    expect(finalText(out)).toBe('¡Hola! 👋 ¿En qué puedo ayudarte hoy?');
    expect(finalText(out)).not.toContain('hoy?¡Hola!'); // the doubling seam
  });

  it('full re-emit under NO message id (random uuid per chunk) → reply once', async () => {
    const { state, out } = buildHarness();
    // messageId null → mapper assigns a fresh uuid per chunk; the consolidated
    // re-emit then lands on yet another id. Must still collapse to one reply.
    await runTurn(state, [
      textChunk(null, '¡Perfecto! '),
      textChunk(null, 'Estoy listo cuando necesites ayuda.'),
      textChunk(null, '¡Perfecto! Estoy listo cuando necesites ayuda.'),
    ]);

    expect(finalText(out)).toBe('¡Perfecto! Estoy listo cuando necesites ayuda.');
  });

  it('plain streaming with no re-emit still renders the reply exactly once', async () => {
    const { state, out } = buildHarness();
    await runTurn(state, [
      textChunk('m', 'First '),
      textChunk('m', 'and second part.'),
    ]);
    expect(finalText(out)).toBe('First and second part.');
  });

  it('a new turn resets — replies do not bleed across turns', async () => {
    const { state, out } = buildHarness();
    await runTurn(state, [textChunk('m1', 'Answer one.')]);
    expect(finalText(out)).toBe('Answer one.');
    await runTurn(state, [textChunk('m2', 'Answer two.')]);
    expect(finalText(out)).toBe('Answer two.');
  });
});
