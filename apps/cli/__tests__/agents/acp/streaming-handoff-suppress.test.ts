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

  it('keeps the fence out of the TERMINAL frames too (closeAll)', async () => {
    const { state, publishOutput, publishStreamingChunk } = makeState();
    state.append({ chunkId: 'msg-1', kind: 'text', delta: prose });
    state.append({ chunkId: 'msg-1', kind: 'text', delta: fenceOpenPart1 });
    state.append({ chunkId: 'msg-1', kind: 'text', delta: fenceOpenPart2 });
    state.append({ chunkId: 'msg-1', kind: 'text', delta: jsonBody + fenceClose });
    publishOutput.mockClear();
    publishStreamingChunk.mockClear();

    await state.closeAll();

    // The terminal frames are the ones that PERSIST — a fence surviving here
    // would stay pinned on the finished bubble forever.
    const finalOutputs = publishOutput.mock.calls
      .map((c) => c[0] as { done?: boolean; content?: string })
      .filter((b) => b.done === true);
    const finalChunks = publishStreamingChunk.mock.calls
      .map((c) => c[0] as { isFinal?: boolean; content?: string })
      .filter((b) => b.isFinal === true);
    expect(finalOutputs.length).toBeGreaterThan(0);
    expect(finalChunks.length).toBeGreaterThan(0);
    for (const frame of [...finalOutputs, ...finalChunks]) {
      expect(frame.content).toBe(prose);
    }
  });

  it('keeps the fence out of the TERMINAL frames too (closeTurnWithInteractiveDetection)', async () => {
    const { state, publishOutput, publishStreamingChunk } = makeState();
    state.append({
      chunkId: 'msg-1',
      kind: 'text',
      delta: prose + fenceOpenPart1 + fenceOpenPart2 + jsonBody + fenceClose,
    });
    // Raw text — fence included — is still what the turn-close extraction reads.
    expect(state.getCurrentText()).toContain(HANDOFF_FENCE_TAG);
    publishOutput.mockClear();
    publishStreamingChunk.mockClear();

    await state.closeTurnWithInteractiveDetection();

    for (const call of [...publishOutput.mock.calls, ...publishStreamingChunk.mock.calls]) {
      const content = (call[0] as { content?: unknown }).content;
      if (typeof content !== 'string') continue;
      expect(content).not.toContain(HANDOFF_FENCE_TAG);
      expect(content).not.toContain('please review the diff');
    }
  });

  it('a quoted codeam-handoff example inside a 4+-backtick block survives INTACT in the TERMINAL frame', async () => {
    const { state, publishOutput, publishStreamingChunk } = makeState();
    const quotedExample = [
      "Here's how the handoff protocol works, for reference:",
      '',
      '````',
      'To hand off, end your reply with:',
      '```' + HANDOFF_FENCE_TAG,
      '{"to":"reviewer","reason":"example only","prompt":"do not run this"}',
      '```',
      '````',
      '',
    ].join('\n');
    state.append({ chunkId: 'msg-1', kind: 'text', delta: quotedExample });
    publishOutput.mockClear();
    publishStreamingChunk.mockClear();

    await state.closeAll();

    const finalOutputs = publishOutput.mock.calls
      .map((c) => c[0] as { done?: boolean; content?: string })
      .filter((b) => b.done === true);
    const finalChunks = publishStreamingChunk.mock.calls
      .map((c) => c[0] as { isFinal?: boolean; content?: string })
      .filter((b) => b.isFinal === true);
    expect(finalOutputs.length).toBeGreaterThan(0);
    expect(finalChunks.length).toBeGreaterThan(0);
    for (const frame of [...finalOutputs, ...finalChunks]) {
      // The quoted example — including its nested ```codeam-handoff fence —
      // must survive verbatim on the persisted bubble, never truncated.
      expect(frame.content).toContain('````');
      expect(frame.content).toContain(HANDOFF_FENCE_TAG);
      expect(frame.content).toContain('do not run this');
    }
  });

  it('a REAL top-level fence after a quoted example: example preserved, real fence stripped from the TERMINAL frame', async () => {
    const { state, publishOutput, publishStreamingChunk } = makeState();
    const text = [
      "Here's how the handoff protocol works, for reference:",
      '',
      '````',
      'To hand off, end your reply with:',
      '```' + HANDOFF_FENCE_TAG,
      '{"to":"reviewer","reason":"example only","prompt":"do not run this"}',
      '```',
      '````',
      '',
      'Given that, I am handing off now.',
      '',
      '```' + HANDOFF_FENCE_TAG,
      '{"to":"reviewer","reason":"real handoff","prompt":"do the real thing"}',
      '```',
      '',
    ].join('\n');
    state.append({ chunkId: 'msg-1', kind: 'text', delta: text });
    publishOutput.mockClear();
    publishStreamingChunk.mockClear();

    await state.closeAll();

    const finalOutputs = publishOutput.mock.calls
      .map((c) => c[0] as { done?: boolean; content?: string })
      .filter((b) => b.done === true);
    const finalChunks = publishStreamingChunk.mock.calls
      .map((c) => c[0] as { isFinal?: boolean; content?: string })
      .filter((b) => b.isFinal === true);
    expect(finalOutputs.length).toBeGreaterThan(0);
    expect(finalChunks.length).toBeGreaterThan(0);
    for (const frame of [...finalOutputs, ...finalChunks]) {
      expect(frame.content).toContain('````');
      expect(frame.content).toContain('do not run this');
      expect(frame.content).toContain('Given that, I am handing off now.');
      // The REAL fence at the tail is stripped.
      expect(frame.content).not.toContain('do the real thing');
    }
  });

  it('a quoted codeam-handoff example inside a 4+-backtick block streams through UNTRUNCATED live', () => {
    const { state, publishOutput, publishStreamingChunk } = makeState();
    const quotedExample = [
      "Here's how the handoff protocol works, for reference:",
      '',
      '````',
      'To hand off, end your reply with:',
      '```' + HANDOFF_FENCE_TAG,
      '{"to":"reviewer","reason":"example only","prompt":"do not run this"}',
      '```',
      '````',
      '',
    ].join('\n');

    // Single delta arrival is enough to prove the LIVE (non-terminal) path
    // no longer truncates at the quoted fence-open marker — before the fix,
    // `handoffFenceStart` (unmasked) would cut right there and every
    // publish after would be stuck showing only the prose that precedes the
    // example, for the rest of the turn.
    state.append({ chunkId: 'msg-1', kind: 'text', delta: quotedExample });

    const publishedTexts = allContents(publishOutput);
    const publishedChunks = allContents(publishStreamingChunk);
    expect(publishedTexts.at(-1)).toBe(quotedExample);
    expect(publishedChunks.at(-1)).toBe(quotedExample);
    for (const content of [...publishedTexts, ...publishedChunks]) {
      expect(content).toContain('````');
      expect(content).toContain(HANDOFF_FENCE_TAG);
      expect(content).toContain('do not run this');
    }
  });

  it('a REAL fence after a quoted example is still truncated LIVE (example untouched, real fence cut)', () => {
    const { state, publishOutput, publishStreamingChunk } = makeState();
    const prefix = [
      "Here's how the handoff protocol works, for reference:",
      '',
      '````',
      'To hand off, end your reply with:',
      '```' + HANDOFF_FENCE_TAG,
      '{"to":"reviewer","reason":"example only","prompt":"do not run this"}',
      '```',
      '````',
      '',
      'Given that, I am handing off now.',
      '',
    ].join('\n');
    const realFenceOpen = '```' + HANDOFF_FENCE_TAG + '\n';
    const realJsonBody = '{"to":"reviewer","reason":"real handoff","prompt":"do the real thing"}\n';

    // Stream the quoted example first — must render live, untruncated.
    state.append({ chunkId: 'msg-1', kind: 'text', delta: prefix });
    expect(allContents(publishOutput).at(-1)).toBe(prefix);

    // Then the REAL fence starts arriving — the live view must now cut
    // right before it and stay pinned there as the JSON body streams in.
    state.append({ chunkId: 'msg-1', kind: 'text', delta: realFenceOpen });
    state.append({ chunkId: 'msg-1', kind: 'text', delta: realJsonBody });

    const publishedTexts = allContents(publishOutput);
    const publishedChunks = allContents(publishStreamingChunk);
    const expectedVisible = prefix.trimEnd();
    expect(publishedTexts.at(-1)).toBe(expectedVisible);
    expect(publishedChunks.at(-1)).toBe(expectedVisible);
    for (const content of [...publishedTexts, ...publishedChunks]) {
      // The quoted example's nested fence survives — only the REAL tail
      // fence is suppressed.
      expect(content).not.toContain('do the real thing');
    }
    // Raw text still carries everything, real fence included, for turn-close
    // extraction.
    expect(state.getCurrentText()).toBe(prefix + realFenceOpen + realJsonBody);
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

  // ─── ACCUMULATED text must receive EVERY delta verbatim ────────────────────
  // fleet-1 round-3 empirical finding: `getCurrentText()` returned the reply
  // with the fence UNCLOSED on a live box, even though the adapter's delta
  // log showed the closing ``` was sent. Traced to a race ABOVE this class
  // (the ACP SDK's stdio dispatch resolves the `session/prompt` RPC response
  // in one promise hop but dispatches a trailing notification several hops
  // deep — see the `setImmediate` drain fix in `client.ts`
  // `sendPromptOnce`), fixed there. This locks in the INVARIANT the fix
  // relies on: `StreamingState.append`'s own accumulation (`getCurrentText`)
  // must always receive every delta verbatim regardless of the live-cut
  // (`handoffFenceStartMasked`) truncating what gets PUBLISHED — feeding the
  // exact split-token delta sequence a real adapter streams (open fence
  // split across several deltas, JSON body, closing fence as its OWN final
  // delta) through the REAL StreamingState.

  it('getCurrentText() ends with the closing fence even when it arrives as its own trailing delta', () => {
    const { state } = makeState();
    const prose = 'Voy a pasar esto a Claude.\n\n';
    const jsonBody =
      '{"to":"claude","reason":"El usuario quiere continuar esta tarea con Claude Code.","prompt":"Continúa desde el contexto actual."}';
    // Mirrors the live delta log: the fence-open marker itself split across
    // several small deltas, then the JSON body, then the closing fence as
    // its own SEPARATE, FINAL delta — the exact shape that exposed the bug.
    const deltas = [prose, '``', '`' + HANDOFF_FENCE_TAG, '\n', jsonBody, '\n', '```'];
    for (const delta of deltas) {
      state.append({ chunkId: 'msg-1', kind: 'text', delta });
    }
    const finalText = state.getCurrentText();
    expect(finalText.endsWith('```')).toBe(true);
    expect(finalText).toBe(prose + '```' + HANDOFF_FENCE_TAG + '\n' + jsonBody + '\n' + '```');
  });

  // ─── FENCE-ONLY reply: the terminal frame must CLEAR, not stick on the last
  // partial-marker litter that streamed live (fleet-1, 2026-08-14 — the phone
  // bubble permanently showed "`codeam-h" because nothing ever replaced it).
  describe('a reply that is NOTHING but the codeam-handoff fence (no prose at all)', () => {
    // Split byte-by-byte so every intermediate live publish is exercised —
    // this is the exact shape that leaked "`codeam-h" live before the fix.
    const deltas = Array.from('```' + HANDOFF_FENCE_TAG + '\n' + jsonBody + '\n' + fenceClose);

    it('never publishes a trailing partial marker on ANY live delta', () => {
      const { state, publishOutput, publishStreamingChunk } = makeState();
      const marker = '```' + HANDOFF_FENCE_TAG;
      // Every strict, non-empty prefix of the marker ("`", "``", "```",
      // "```c", … "```codeam-handof") — none of these may EVER be the
      // trailing content of a published frame.
      const partialPrefixes = Array.from({ length: marker.length - 1 }, (_, i) =>
        marker.slice(0, i + 1),
      );
      for (const delta of deltas) {
        state.append({ chunkId: 'msg-1', kind: 'text', delta });
      }
      for (const content of [
        ...allContents(publishOutput),
        ...allContents(publishStreamingChunk),
      ]) {
        for (const partial of partialPrefixes) {
          expect(content.endsWith(partial)).toBe(false);
        }
      }
    });

    it('closeAll clears the terminal frame to EMPTY — never sticks on the last live litter', async () => {
      const { state, publishOutput, publishStreamingChunk } = makeState();
      for (const delta of deltas) {
        state.append({ chunkId: 'msg-1', kind: 'text', delta });
      }
      publishOutput.mockClear();
      publishStreamingChunk.mockClear();

      await state.closeAll();

      const finalOutputs = publishOutput.mock.calls
        .map((c) => c[0] as { done?: boolean; content?: string })
        .filter((b) => b.done === true);
      const finalChunks = publishStreamingChunk.mock.calls
        .map((c) => c[0] as { isFinal?: boolean; content?: string })
        .filter((b) => b.isFinal === true);
      expect(finalOutputs.length).toBeGreaterThan(0);
      expect(finalChunks.length).toBeGreaterThan(0);
      for (const frame of [...finalOutputs, ...finalChunks]) {
        // An EXPLICIT empty frame — not a no-op that leaves the last partial
        // marker frame as the effective "final" state on the wire.
        expect(frame.content).toBe('');
      }
    });

    it('closeTurnWithInteractiveDetection clears the terminal frame to EMPTY too', async () => {
      const { state, publishOutput, publishStreamingChunk } = makeState();
      for (const delta of deltas) {
        state.append({ chunkId: 'msg-1', kind: 'text', delta });
      }
      publishOutput.mockClear();
      publishStreamingChunk.mockClear();

      await state.closeTurnWithInteractiveDetection();

      const finalOutputs = publishOutput.mock.calls
        .map((c) => c[0] as { done?: boolean; content?: string })
        .filter((b) => b.done === true);
      const finalChunks = publishStreamingChunk.mock.calls
        .map((c) => c[0] as { isFinal?: boolean; content?: string })
        .filter((b) => b.isFinal === true);
      expect(finalOutputs.length).toBeGreaterThan(0);
      expect(finalChunks.length).toBeGreaterThan(0);
      for (const frame of [...finalOutputs, ...finalChunks]) {
        expect(frame.content).toBe('');
      }
    });
  });
});
