import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import { NativeTuiDriver, type NativeTuiDriverDeps } from '../../src/baton/native-tui-driver';
import type { AgentService } from '../../src/services/agent.service';
import type { RuntimeStrategy } from '../../src/agents/strategy';
import type { CommandRelayService, RemoteCommand } from '../../src/services/command-relay.service';

function fakeAgent(id: string) {
  return {
    spawn: vi.fn(async () => {}),
    restart: vi.fn(async (_sid: string, _auto: boolean) => {}),
    kill: vi.fn(() => {}),
    sendCommand: vi.fn((_text: string) => {}),
    spawnedSessionId: id as string | null,
  };
}

function makeDeps(
  agent: ReturnType<typeof fakeAgent>,
  extra: Partial<NativeTuiDriverDeps> = {},
): { deps: NativeTuiDriverDeps; relay: { sendResult: ReturnType<typeof vi.fn> } } {
  const relay = { sendResult: vi.fn(async () => {}) };
  const deps: NativeTuiDriverDeps = {
    agent: agent as unknown as AgentService,
    runtime: {} as unknown as RuntimeStrategy,
    opts: {
      sessionId: 's',
      pluginId: 'p',
      agentId: 'claude',
      pluginAuthToken: 't',
      cwd: os.tmpdir(),
    },
    getRelay: () => relay as unknown as CommandRelayService,
    getBeads: () => null,
    ...extra,
  };
  return { deps, relay };
}

describe('NativeTuiDriver', () => {
  it('start(undefined) spawns fresh and returns the minted session id', async () => {
    const agent = fakeAgent('conv-9');
    const d = new NativeTuiDriver(makeDeps(agent).deps);
    const id = await d.start();
    expect(agent.spawn).toHaveBeenCalledTimes(1);
    expect(id).toBe('conv-9');
    expect(d.kind).toBe('local_tui');
  });

  it('start(id) resumes via restart(id, false) and returns that id', async () => {
    const agent = fakeAgent('conv-9');
    const d = new NativeTuiDriver(makeDeps(agent).deps);
    const id = await d.start('conv-42');
    expect(agent.restart).toHaveBeenCalledWith('conv-42', false);
    expect(id).toBe('conv-42');
  });

  it('stop kills the PTY', async () => {
    const agent = fakeAgent('conv-9');
    const d = new NativeTuiDriver(makeDeps(agent).deps);
    await d.start();
    await d.stop();
    expect(agent.kill).toHaveBeenCalledTimes(1);
  });

  it('whenSafeToYield resolves after idleMs of no output', async () => {
    vi.useFakeTimers();
    const agent = fakeAgent('conv-9');
    const d = new NativeTuiDriver(makeDeps(agent, { idleMs: 500 }).deps);
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

  it('handlePtyData() resets the idle window rather than merely seeding it at construction', async () => {
    vi.useFakeTimers();
    try {
      const agent = fakeAgent('conv-9');
      const d = new NativeTuiDriver(makeDeps(agent, { idleMs: 500 }).deps);
      await d.start();

      let done = false;
      const p = d.whenSafeToYield().then(() => (done = true));

      // Let real time pass BEFORE feeding data so a pass here can only be
      // explained by handlePtyData() actually resetting the clock.
      await vi.advanceTimersByTimeAsync(200);
      expect(done).toBe(false);

      d.handlePtyData('some pty output'); // resets the idle window at t=200

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
    const d = new NativeTuiDriver(makeDeps(agent).deps);
    await expect(d.start(undefined)).rejects.toThrow(
      'NativeTuiDriver: agent did not expose a session id after spawn',
    );
    expect(agent.spawn).toHaveBeenCalledTimes(1);
    expect(agent.restart).not.toHaveBeenCalled();
  });

  it('dispatch routes a non-baton command through the legacy PTY dispatchCommand', async () => {
    const agent = fakeAgent('conv-9');
    const { deps, relay } = makeDeps(agent);
    const d = new NativeTuiDriver(deps);
    await d.start();
    // set_keep_alive is network-free: it flips the (local, no-op) keep-alive and
    // acks over the relay — proof the command reached the PTY dispatch table.
    await d.dispatch({
      id: 'cmd1',
      sessionId: 's',
      type: 'set_keep_alive',
      payload: { enabled: true },
    } as RemoteCommand);
    expect(relay.sendResult).toHaveBeenCalledWith(
      'cmd1',
      'success',
      expect.objectContaining({ enabled: true, applied: false, runtime: 'local' }),
    );
  });
});
