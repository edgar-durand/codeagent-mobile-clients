import { describe, it, expect, vi } from 'vitest';
import { StreamingState } from '../../../src/agents/acp/runner';
import { AcpPublisher } from '../../../src/agents/acp/publisher';

/**
 * Regression: the "thinking / tool-call chips render on the first turn then
 * STOP after a couple messages" bug.
 *
 * thinking / tool_use / tool_result ride the Epic C streaming-chunk feed and
 * are keyed by `chunkId` on the mobile side. `claude-agent-acp` REUSES the same
 * adapter id — `toolu_01` — for the first tool of EVERY turn. Once turn 1's
 * `toolu_01` chunk was flushed `isFinal:true`, a later turn's `toolu_01` landed
 * on the already-finalized chunk and was dropped → chips vanished after turn 1.
 *
 * The fix namespaces every streaming-chunk id with a per-turn counter, so the
 * SAME reused adapter id maps to a DISTINCT feed id each turn, while staying
 * constant WITHIN a turn (so a tool_result still updates its tool_call's chip).
 */
function makeState(): {
  state: StreamingState;
  scChunkIds: (kind?: string) => string[];
} {
  const publisher = new AcpPublisher({
    sessionId: 'sess-1',
    pluginId: 'plugin-1',
    pluginAuthToken: 'tok-1',
    apiBaseUrl: 'https://api.example.test',
  });
  vi.spyOn(publisher, 'publishOutput').mockResolvedValue(undefined);
  const sc = vi.spyOn(publisher, 'publishStreamingChunk').mockResolvedValue(undefined);
  const scChunkIds = (kind?: string): string[] =>
    sc.mock.calls
      .map((c) => c[0] as { chunkId: string; kind: string })
      .filter((e) => (kind ? e.kind === kind : true))
      .map((e) => e.chunkId);
  return { state: new StreamingState(publisher), scChunkIds };
}

describe('StreamingState — streaming-chunk id is unique per turn', () => {
  it('does NOT reuse a tool chunkId across turns when the adapter repeats it', async () => {
    const { state, scChunkIds } = makeState();

    // Turn 1: the adapter's first tool is `toolu_01`.
    await state.beginTurn();
    state.append({ chunkId: 'toolu_01', kind: 'tool_use', delta: 'ls -la' });
    await state.closeAll(); // flushes turn 1's chunks isFinal:true

    // Turn 2: the adapter REUSES `toolu_01` for this turn's first tool.
    await state.beginTurn();
    state.append({ chunkId: 'toolu_01', kind: 'tool_use', delta: 'cat README.md' });

    // Distinct ids across both turns (the live append + the closeAll flush of
    // turn 1 republish the SAME id, so count by DISTINCT). The bug published
    // the literal `toolu_01` both turns → 1 distinct id → mobile dropped turn
    // 2's chunk as already-finalized. Post-fix: 2 distinct (one per turn).
    expect(new Set(scChunkIds('tool_use')).size).toBe(2);
  });

  it('keeps the chunkId STABLE within a turn so a tool_result updates its tool_call', async () => {
    const { state, scChunkIds } = makeState();
    await state.beginTurn();
    state.append({ chunkId: 'toolu_01', kind: 'tool_use', delta: 'ls' });
    state.append({ chunkId: 'toolu_01', kind: 'tool_result', delta: 'file.ts' });
    // tool_call and its tool_result must share ONE feed id (one chip updating).
    expect(new Set(scChunkIds()).size).toBe(1);
  });

  it('thinking chips also get a fresh id each turn', async () => {
    const { state, scChunkIds } = makeState();
    await state.beginTurn();
    state.append({ chunkId: 'think_1', kind: 'thinking', delta: 'pondering…' });
    await state.closeAll();
    await state.beginTurn();
    state.append({ chunkId: 'think_1', kind: 'thinking', delta: 'pondering again…' });
    expect(new Set(scChunkIds('thinking')).size).toBe(2);
  });
});
