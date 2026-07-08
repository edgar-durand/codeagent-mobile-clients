import { describe, expect, it, vi } from 'vitest';
import { AcpClient } from '../../../src/agents/acp/client';
import type { AcpClientOptions } from '../../../src/agents/acp/client';

/**
 * Regression for codeagent-9u9: a 2nd prompt() arriving while one is in flight
 * used to overwrite `this.promptIdle` + clear `this.pendingToolCalls` mid-turn,
 * so turn A's idle watchdog stopped being fed and could spuriously fail
 * "ACP prompt idle" while the agent was still working. Mobile "send-while-active"
 * makes two back-to-back prompts reachable. The fix serializes turns.
 */

function makeClient(): AcpClient {
  const opts: AcpClientOptions = {
    adapter: {} as unknown as AcpClientOptions['adapter'],
    cwd: '/tmp/work',
    onSessionUpdate: () => undefined,
    onRequestPermission: (async () => ({
      outcome: { outcome: 'cancelled' },
    })) as unknown as AcpClientOptions['onRequestPermission'],
  };
  return new AcpClient(opts);
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
}
function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Internals {
  connection: { prompt: ReturnType<typeof vi.fn> } | null;
  sessionId: string | null;
  promptIdle: unknown;
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('AcpClient.prompt — turn serialization (9u9)', () => {
  it('does not send a 2nd prompt to the adapter until the 1st has settled', async () => {
    const client = makeClient();
    const a = defer<{ stopReason: string }>();
    const b = defer<{ stopReason: string }>();
    const calls: string[] = [];
    const prompt = vi.fn((req: { prompt: Array<{ type: string; text?: string }> }) => {
      const text = req.prompt.map((x) => x.text ?? '').join('');
      calls.push(text);
      return text === 'A' ? a.promise : b.promise;
    });
    const internals = client as unknown as Internals;
    internals.connection = { prompt };
    internals.sessionId = 'sess-1';

    const pA = client.prompt('A');
    const pB = client.prompt('B');

    // Only A reaches the connection; B is queued behind it (not clobbering A).
    await tick();
    expect(calls).toEqual(['A']);

    // A settles → B is released to the adapter.
    a.resolve({ stopReason: 'end_turn' });
    await pA;
    await tick();
    expect(calls).toEqual(['A', 'B']);

    b.resolve({ stopReason: 'end_turn' });
    await pB;
    // Both settled → the idle-watchdog handle is disarmed (no dangling timer).
    expect(internals.promptIdle).toBeNull();
  });

  it('a rejected 1st prompt does not wedge the queue — the 2nd still runs', async () => {
    const client = makeClient();
    const a = defer<{ stopReason: string }>();
    const b = defer<{ stopReason: string }>();
    const calls: string[] = [];
    const prompt = vi.fn((req: { prompt: Array<{ type: string; text?: string }> }) => {
      const text = req.prompt.map((x) => x.text ?? '').join('');
      calls.push(text);
      return text === 'A' ? a.promise : b.promise;
    });
    const internals = client as unknown as Internals;
    internals.connection = { prompt };
    internals.sessionId = 'sess-1';

    const pA = client.prompt('A');
    const pB = client.prompt('B');
    await tick();

    a.reject(new Error('boom'));
    await expect(pA).rejects.toThrow('boom');
    await tick();

    expect(calls).toEqual(['A', 'B']);
    b.resolve({ stopReason: 'end_turn' });
    await pB;
  });
});
