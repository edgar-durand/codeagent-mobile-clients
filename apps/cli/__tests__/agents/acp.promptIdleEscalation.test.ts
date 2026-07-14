/**
 * The prompt watchdog must be built with the TWO-TIER windows — strict
 * 90s until the first update, 600s once the turn is provably alive.
 * Regression for the 2026-07-14 compaction brick: context auto-compaction
 * emits one "Compacting..." chunk then runs silently for minutes; the flat
 * 90s window aborted it every turn, permanently bricking the session
 * (every next prompt re-triggered the same doomed compaction).
 */

import { describe, expect, it, vi } from 'vitest';

const calls: Array<{ idleMs: number; activeIdleMs: number | undefined }> = [];

vi.mock('../../src/agents/acp/idleTimeout', () => ({
  createIdleTimeout: (idleMs: number, _makeError: () => Error, activeIdleMs?: number) => {
    calls.push({ idleMs, activeIdleMs });
    return {
      promise: new Promise<never>(() => {}),
      bump: () => {},
      suspend: () => {},
      clear: () => {},
    };
  },
}));

import { AcpClient, type AcpClientOptions } from '../../src/agents/acp/client';

interface ClientInternals {
  connection: { prompt: (p: unknown) => Promise<unknown> } | null;
  sessionId: string | null;
}

describe('AcpClient prompt idle wiring', () => {
  it('arms the watchdog with the strict window AND the escalated active window', async () => {
    const client = new AcpClient({
      adapter: { command: 'node', args: [] },
      cwd: '/tmp',
      onSessionUpdate: () => {},
    } as unknown as AcpClientOptions);
    const internals = client as unknown as ClientInternals;
    internals.connection = {
      prompt: async () => ({ stopReason: 'end_turn' }),
    };
    internals.sessionId = 'sess-1';

    await client.prompt('hola');

    expect(calls).toHaveLength(1);
    expect(calls[0].idleMs).toBe(90_000);
    // The active window MUST comfortably cover a multi-minute compaction.
    expect(calls[0].activeIdleMs).toBeDefined();
    expect(calls[0].activeIdleMs!).toBeGreaterThanOrEqual(300_000);
  });
});
