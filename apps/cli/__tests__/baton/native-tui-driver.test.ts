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
});
