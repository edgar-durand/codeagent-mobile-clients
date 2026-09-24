/**
 * Regression for the glued-paragraphs bug (bead codeagent-wqpi).
 *
 * Codex emits several `agent_message_chunk` messages in ONE turn, separated
 * by tool calls: '…run every gate.' (msg A) → tools → "I'm resuming at…"
 * (msg B). Every text delta of a turn collapses onto `turnTextChunkId` (the
 * reply-doubling guard) and `reconcileCumulative` appended B's first byte
 * straight onto A's last byte → the user read "gate.I'm resuming" (replay
 * 2026-09-23 viveknimawat S1 f070; also 'endpoint.The', 'syncing.All'). Both
 * feeds carried the glued string, so the boundary can only be restored here.
 *
 * Contract: a text delta under a NEW message id that APPENDS starts a new
 * paragraph; a snapshot re-emit under a new id still reconciles as REPLACE
 * (no doubling); a delta that already begins with whitespace is left alone.
 */
import { describe, expect, it, vi } from 'vitest';
import { StreamingState } from '../../../src/agents/acp/runner';
import { mapSessionUpdate } from '../../../src/agents/acp/mappers';
import { AcpPublisher } from '../../../src/agents/acp/publisher';

function makeState(): { state: StreamingState; lastText: () => string } {
  const publisher = new AcpPublisher({
    sessionId: 'sess-1',
    pluginId: 'plugin-1',
    pluginAuthToken: 'tok-1',
    apiBaseUrl: 'https://api.example.test',
  });
  vi.spyOn(publisher, 'publishOutput').mockResolvedValue(undefined);
  const sc = vi.spyOn(publisher, 'publishStreamingChunk').mockResolvedValue(undefined);
  const lastText = (): string => {
    let out = '';
    for (const call of sc.mock.calls) {
      const e = call[0] as { kind: string; content: string };
      if (e.kind === 'text') out = e.content;
    }
    return out;
  };
  return { state: new StreamingState(publisher), lastText };
}

function messageChunk(messageId: string | null, text: string) {
  return {
    sessionId: 'sess-1',
    update: { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } },
  } as unknown as Parameters<typeof mapSessionUpdate>[0];
}

function toolCall(id: string) {
  return {
    sessionId: 'sess-1',
    update: { sessionUpdate: 'tool_call', toolCallId: id, title: 'Bash', kind: 'execute', status: 'completed' },
  } as unknown as Parameters<typeof mapSessionUpdate>[0];
}

/** Drives a turn and returns the reply text as it stood when the turn closed. */
async function runTurn(
  state: StreamingState,
  notes: Parameters<typeof mapSessionUpdate>[0][],
): Promise<string> {
  await state.beginTurn({ clear: false });
  for (const note of notes) for (const delta of mapSessionUpdate(note)) state.append(delta);
  const text = state.getCurrentText();
  await state.closeAll();
  return text;
}

describe('ACP text — a new message after a finished sentence is a new paragraph', () => {
  it('two Codex messages around a tool call render as two paragraphs, not glued', async () => {
    const { state, lastText } = makeState();
    const text = await runTurn(state, [
      messageChunk('msg-A', "I'll run every "),
      messageChunk('msg-A', 'gate.'),
      toolCall('call-1'),
      messageChunk('msg-B', "I'm resuming at the audit step."),
    ]);
    expect(text).toBe("I'll run every gate.\n\nI'm resuming at the audit step.");
    expect(lastText()).not.toContain("gate.I'm");
  });

  it('a full re-emit of the same reply under a 2nd message id still collapses (no doubling)', async () => {
    const { state } = makeState();
    const text = await runTurn(state, [
      messageChunk('msg-A', 'Hello '),
      messageChunk('msg-A', 'there.'),
      messageChunk('msg-B', 'Hello there.'),
    ]);
    expect(text).toBe('Hello there.');
  });

  it('a new message that already starts with whitespace gets no extra break', async () => {
    const { state } = makeState();
    const text = await runTurn(state, [messageChunk('a', 'Done.'), messageChunk('b', '\n\nNext step.')]);
    expect(text).toBe('Done.\n\nNext step.');
  });

  it('same-message deltas keep streaming byte-for-byte', async () => {
    const { state } = makeState();
    const text = await runTurn(state, [messageChunk('m', 'v1.2.'), messageChunk('m', 'Final')]);
    expect(text).toBe('v1.2.Final');
  });
});
