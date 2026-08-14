import { describe, it, expect, vi } from 'vitest';
import { StreamingState } from '../../../src/agents/acp/runner';
import { AcpPublisher } from '../../../src/agents/acp/publisher';
import { HANDOFF_FENCE_TAG } from '@codeam/shared';

/**
 * A ```codeam-handoff fence proposed at the tail of a reply is protocol
 * litter, not user-visible prose (see `handoff-protocol.ts`). It must never
 * render in the live stream — chat pipe (`publishOutput`) or the
 * streaming-chunk feed (`publishStreamingChunk`) — even when the fence
 * arrives split across several `agent_message_chunk` deltas, as real ACP
 * adapters stream token-by-token. Extraction/removal for the durable turn
 * happens at turn close (a later task); this only covers presentation-layer
 * suppression while streaming, so `getCurrentText()` must still return the
 * FULL raw text (fence included).
 */

function makeState(): {
  state: StreamingState;
  publishOutput: ReturnType<typeof vi.fn>;
  publishStreamingChunk: ReturnType<typeof vi.fn>;
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
  const publishStreamingChunk = vi
    .spyOn(publisher, 'publishStreamingChunk')
    .mockResolvedValue(undefined);
  return { state: new StreamingState(publisher), publishOutput, publishStreamingChunk };
}

/** Every `content` string posted on a spied publish method. */
function allContents(mockFn: ReturnType<typeof vi.fn>): string[] {
  return mockFn.mock.calls
    .map((c) => c[0] as { content?: unknown })
    .filter((b): b is { content: string } => typeof b.content === 'string')
    .map((b) => b.content);
}

describe('StreamingState.append — codeam-handoff fence suppressed from the live stream', () => {
  const prose = "Here's the fix. Handing this off to the reviewer now.";
  // Split the fence open marker across two deltas so the literal
  // ```codeam-handoff substring does not exist until the second one lands —
  // exercising the real streaming shape (token-by-token), not a single
  // atomic chunk.
  const fenceOpenPart1 = '\n\n``';
  const fenceOpenPart2 = '`' + HANDOFF_FENCE_TAG + '\n';
  const jsonBody =
    '{"to":"reviewer","reason":"needs a second pass","prompt":"please review the diff"}\n';
  const fenceClose = '```';

  it('never publishes the fence tag or JSON body across a multi-delta arrival, while pre-fence prose IS published', () => {
    const { state, publishOutput, publishStreamingChunk } = makeState();

    state.append({ chunkId: 'msg-1', kind: 'text', delta: prose });
    state.append({ chunkId: 'msg-1', kind: 'text', delta: fenceOpenPart1 });
    state.append({ chunkId: 'msg-1', kind: 'text', delta: fenceOpenPart2 });
    state.append({ chunkId: 'msg-1', kind: 'text', delta: jsonBody });
    state.append({ chunkId: 'msg-1', kind: 'text', delta: fenceClose });

    const publishedTexts = allContents(publishOutput);
    const publishedChunks = allContents(publishStreamingChunk);
    expect(publishedTexts.length).toBeGreaterThan(0);
    expect(publishedChunks.length).toBeGreaterThan(0);

    for (const content of [...publishedTexts, ...publishedChunks]) {
      expect(content).not.toContain(HANDOFF_FENCE_TAG);
      expect(content).not.toContain('"reviewer"');
      expect(content).not.toContain('please review the diff');
    }

    // Pre-fence prose IS published — the very first delta, before any fence
    // content exists.
    expect(publishedTexts[0]).toBe(prose);
    expect(publishedChunks[0]).toBe(prose);

    // Once the fence fully forms, every subsequent publish converges on the
    // prose with the fence truncated off — never regresses back to leaking
    // fence bytes as more of the JSON body streams in.
    expect(publishedTexts[publishedTexts.length - 1]).toBe(prose);
    expect(publishedChunks[publishedChunks.length - 1]).toBe(prose);

    // getCurrentText() is the FULL raw text — fence included — for turn
    // close / handoff extraction to consume.
    expect(state.getCurrentText()).toBe(
      prose + fenceOpenPart1 + fenceOpenPart2 + jsonBody + fenceClose,
    );
  });

  it('publishes identically to before when no fence is present (regression guard)', () => {
    const { state, publishOutput, publishStreamingChunk } = makeState();
    state.append({ chunkId: 'msg-1', kind: 'text', delta: 'The ' });
    state.append({ chunkId: 'msg-1', kind: 'text', delta: 'answer ' });
    state.append({ chunkId: 'msg-1', kind: 'text', delta: 'is 42.' });

    expect(state.getCurrentText()).toBe('The answer is 42.');
    expect(allContents(publishOutput)).toEqual(['The ', 'The answer ', 'The answer is 42.']);
    expect(allContents(publishStreamingChunk)).toEqual([
      'The ',
      'The answer ',
      'The answer is 42.',
    ]);
  });
});
