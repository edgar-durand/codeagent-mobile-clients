/**
 * Integration regression for the doubled-THINKING bug — the thinking twin of
 * `acp.replyDoubling.test.ts`. Driven end to end through the REAL ACP path:
 * raw `agent_thought_chunk` SessionNotifications → `mapSessionUpdate` (the
 * actual mapper) → `StreamingState.append` / `closeAll` (the actual runner) →
 * the thinking/activity content the user sees on the streaming-chunk feed.
 *
 * The wire below mirrors a LIVE box's debug log for a "Hola" turn
 * (claude-agent-acp ≥0.47):
 *
 *   #7 agent_thought_chunk  text:"The user said \"Hola\"..."      (delta, id A)
 *   #8 agent_thought_chunk  text:" I'll respond briefly."          (delta, id A)
 *   #9 agent_thought_chunk  text:"The user said \"Hola\"... I'll respond briefly."
 *                                                                  (FULL re-emit, id B)
 *
 * #9 is the adapter re-emitting the CONSOLIDATED thought under a DIFFERENT
 * message id after its own streamed-vs-consolidated dedupe misfires. The text
 * stream is already protected by the per-turn `turnTextChunkId` collapse;
 * thinking was NOT — so the consolidated re-emit lands in a 2nd `::thought`
 * buffer and the activity card concatenates both → the visible doubling
 * ("TheThe user said …briefly.The user said …briefly.").
 *
 * REGRESSION PROOF: this test FAILS against the pre-fix runner (thinking keys
 * off the adapter's own `delta.chunkId`) and PASSES once thinking collapses
 * onto a per-turn `turnThoughtChunkId` reconcile buffer.
 */

import { describe, expect, it, vi } from 'vitest';
import { StreamingState } from '../../../src/agents/acp/runner';
import { mapSessionUpdate } from '../../../src/agents/acp/mappers';
import { AcpPublisher } from '../../../src/agents/acp/publisher';

function makeState(): {
  state: StreamingState;
  scContent: (kind: string) => string[];
} {
  const publisher = new AcpPublisher({
    sessionId: 'sess-1',
    pluginId: 'plugin-1',
    pluginAuthToken: 'tok-1',
    apiBaseUrl: 'https://api.example.test',
  });
  vi.spyOn(publisher, 'publishOutput').mockResolvedValue(undefined);
  const sc = vi.spyOn(publisher, 'publishStreamingChunk').mockResolvedValue(undefined);
  // The terminal content per chunkId of the requested kind, in the order the
  // chunkIds first appeared — this is what the mobile activity card renders
  // (it coalesces by chunkId; if a turn flushes TWO thought chunkIds, the card
  // shows BOTH stacked → the doubling).
  const scContent = (kind: string): string[] => {
    const byId = new Map<string, string>();
    for (const call of sc.mock.calls) {
      const e = call[0] as { chunkId: string; kind: string; content: string };
      if (e.kind === kind) byId.set(e.chunkId, e.content);
    }
    return Array.from(byId.values());
  };
  return { state: new StreamingState(publisher), scContent };
}

/** A real ACP `agent_thought_chunk` notification (text content block). */
function thoughtChunk(messageId: string | null, text: string) {
  return {
    sessionId: 'sess-1',
    update: {
      sessionUpdate: 'agent_thought_chunk',
      messageId,
      content: { type: 'text', text },
    },
  } as unknown as Parameters<typeof mapSessionUpdate>[0];
}

async function runTurn(
  state: StreamingState,
  notes: ReturnType<typeof thoughtChunk>[],
): Promise<void> {
  await state.beginTurn({ clear: false });
  for (const note of notes) {
    for (const delta of mapSessionUpdate(note)) state.append(delta);
  }
  await state.closeAll();
}

describe('ACP thinking must not double (integration: notification → mapper → runner)', () => {
  it('streamed thought deltas + consolidated full re-emit under a 2nd message id → thought once', async () => {
    const { state, scContent } = makeState();
    await runTurn(state, [
      thoughtChunk('msg-A', 'The user said "Hola".'),
      thoughtChunk('msg-A', " I'll respond briefly."),
      // consolidated re-emit of the whole thought, under a DIFFERENT message id
      thoughtChunk('msg-B', 'The user said "Hola". I\'ll respond briefly.'),
    ]);

    const thoughts = scContent('thinking');
    // Exactly ONE consolidated thought chunk, no doubling seam.
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0]).toBe('The user said "Hola". I\'ll respond briefly.');
    expect(thoughts[0]).not.toContain('briefly.The user'); // the doubling seam
    expect(thoughts[0]).not.toContain('TheThe');
  });

  it('full thought re-emit under NO message id (random uuid per chunk) → thought once', async () => {
    const { state, scContent } = makeState();
    await runTurn(state, [
      thoughtChunk(null, 'Considering the request. '),
      thoughtChunk(null, 'Plan: answer concisely.'),
      thoughtChunk(null, 'Considering the request. Plan: answer concisely.'),
    ]);

    const thoughts = scContent('thinking');
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0]).toBe('Considering the request. Plan: answer concisely.');
  });

  it('plain thought streaming with no re-emit still renders once', async () => {
    const { state, scContent } = makeState();
    await runTurn(state, [
      thoughtChunk('m', 'First thought '),
      thoughtChunk('m', 'and second part.'),
    ]);
    const thoughts = scContent('thinking');
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0]).toBe('First thought and second part.');
  });

  it('a new turn resets — thoughts do not bleed across turns', async () => {
    const { state, scContent } = makeState();
    await runTurn(state, [thoughtChunk('m1', 'Thought one.')]);
    await runTurn(state, [thoughtChunk('m2', 'Thought two.')]);
    // Two turns → two DISTINCT thought chunkIds, each its own content.
    const thoughts = scContent('thinking');
    expect(thoughts).toContain('Thought one.');
    expect(thoughts).toContain('Thought two.');
    expect(thoughts).toHaveLength(2);
  });
});
