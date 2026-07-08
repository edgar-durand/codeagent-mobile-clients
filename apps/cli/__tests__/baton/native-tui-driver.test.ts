import { describe, it, expect, vi } from 'vitest';
import { NativeTuiDriver } from '../../src/baton/native-tui-driver';

function fakeAgent(id: string) {
  return {
    spawn: vi.fn(async () => {}),
    restart: vi.fn(async (_sid: string, _auto: boolean) => {}),
    kill: vi.fn(() => {}),
    spawnedSessionId: id as string | null,
  };
}

describe('NativeTuiDriver', () => {
  it('start(undefined) spawns fresh and returns the minted session id', async () => {
    const agent = fakeAgent('conv-9');
    const d = new NativeTuiDriver({ agent });
    const id = await d.start();
    expect(agent.spawn).toHaveBeenCalledTimes(1);
    expect(id).toBe('conv-9');
    expect(d.kind).toBe('local_tui');
  });

  it('start(id) resumes via restart(id, false) and returns that id', async () => {
    const agent = fakeAgent('conv-9');
    const d = new NativeTuiDriver({ agent });
    const id = await d.start('conv-42');
    expect(agent.restart).toHaveBeenCalledWith('conv-42', false);
    expect(id).toBe('conv-42');
  });

  it('stop kills the PTY', async () => {
    const agent = fakeAgent('conv-9');
    const d = new NativeTuiDriver({ agent });
    await d.start();
    await d.stop();
    expect(agent.kill).toHaveBeenCalledTimes(1);
  });

  it('whenSafeToYield resolves after idleMs of no output', async () => {
    vi.useFakeTimers();
    const agent = fakeAgent('conv-9');
    const d = new NativeTuiDriver({ agent, idleMs: 500 });
    await d.start();
    let done = false;
    const p = d.whenSafeToYield().then(() => (done = true));
    d.noteOutput(); // a turn is producing output
    await vi.advanceTimersByTimeAsync(300);
    expect(done).toBe(false); // still within the idle window
    await vi.advanceTimersByTimeAsync(500);
    await p;
    expect(done).toBe(true); // 500ms quiet => safe boundary
    vi.useRealTimers();
  });

  it('noteOutput() resets the idle window rather than merely seeding it at construction', async () => {
    vi.useFakeTimers();
    try {
      const agent = fakeAgent('conv-9');
      const d = new NativeTuiDriver({ agent, idleMs: 500 });
      await d.start();

      let done = false;
      const p = d.whenSafeToYield().then(() => (done = true));

      // Let real time pass BEFORE calling noteOutput() so a pass here can only
      // be explained by noteOutput() actually resetting the clock — if it were
      // a no-op (idle window still anchored to construction time), this alone
      // would already be past idleMs and the promise would have resolved.
      await vi.advanceTimersByTimeAsync(200);
      expect(done).toBe(false);

      d.noteOutput(); // resets the idle window at t=200

      // Only 300ms have elapsed since the reset — still within the window.
      await vi.advanceTimersByTimeAsync(300);
      expect(done).toBe(false);

      // Now >=500ms have elapsed since the reset (300 + 300 = 600ms).
      await vi.advanceTimersByTimeAsync(300);
      await p;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('start(undefined) throws when the agent exposes no session id after spawn', async () => {
    const agent = fakeAgent('conv-9');
    agent.spawnedSessionId = null;
    const d = new NativeTuiDriver({ agent });
    await expect(d.start(undefined)).rejects.toThrow(
      'NativeTuiDriver: agent did not expose a session id after spawn',
    );
    expect(agent.spawn).toHaveBeenCalledTimes(1);
    expect(agent.restart).not.toHaveBeenCalled();
  });
});
