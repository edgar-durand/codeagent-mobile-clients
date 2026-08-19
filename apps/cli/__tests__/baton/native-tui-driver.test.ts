import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import { NativeTuiDriver, type NativeTuiDriverDeps } from '../../src/baton/native-tui-driver';
import type { AgentService } from '../../src/services/agent.service';
import type { RuntimeStrategy } from '../../src/agents/strategy';
import type { CommandRelayService, RemoteCommand } from '../../src/services/command-relay.service';
import { _transport as chunkTransport } from '../../src/services/output/chunk-emitter';
import { createRuntimeStrategy } from '../../src/agents/registry';

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

  describe('conversation-switch watch (Claude `/clear` / `/resume`)', () => {
    function runtimeWithWatch() {
      const unwatch = vi.fn();
      let fire: ((id: string, info: { kind: 'new' | 'resumed' }) => void) | null = null;
      const watchConversationSwitch = vi.fn(
        (_cwd: string, _opts: { currentId: string }, onSwitch: (id: string, info: { kind: 'new' | 'resumed' }) => void) => {
          fire = onSwitch;
          return unwatch;
        },
      );
      return {
        runtime: { watchConversationSwitch } as unknown as RuntimeStrategy,
        watchConversationSwitch,
        unwatch,
        fire: (id: string) => fire?.(id, { kind: 'new' }),
      };
    }

    it('arms the runtime watcher on the pre-minted id after a fresh start and forwards a switch to onConversationSwitch', async () => {
      const agent = fakeAgent('conv-9');
      const rt = runtimeWithWatch();
      const onConversationSwitch = vi.fn();
      const d = new NativeTuiDriver(makeDeps(agent, { runtime: rt.runtime, onConversationSwitch }).deps);
      await d.start();
      expect(rt.watchConversationSwitch).toHaveBeenCalledTimes(1);
      expect(rt.watchConversationSwitch.mock.calls[0][1].currentId).toBe('conv-9');
      rt.fire('conv-after-clear');
      expect(onConversationSwitch).toHaveBeenCalledWith('conv-after-clear');
    });

    it('re-arms on the resumed id after a handback, and tears the watcher down on stop()', async () => {
      const agent = fakeAgent('conv-9');
      const rt = runtimeWithWatch();
      const d = new NativeTuiDriver(makeDeps(agent, { runtime: rt.runtime }).deps);
      await d.start('conv-42');
      expect(rt.watchConversationSwitch.mock.calls[0][1].currentId).toBe('conv-42');
      await d.stop();
      expect(rt.unwatch).toHaveBeenCalledTimes(1);
    });

    it('is inert for runtimes without the hook', async () => {
      const agent = fakeAgent('conv-9');
      const d = new NativeTuiDriver(makeDeps(agent).deps);
      await expect(d.start()).resolves.toBe('conv-9');
      await expect(d.stop()).resolves.toBeUndefined();
    });
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

  it('discoverSessionId (boot-store agent, Kimi): quick probe binds the id', async () => {
    const agent = fakeAgent('conv-9');
    agent.spawnedSessionId = null; // no pre-mint
    const discoverSessionId = vi.fn(async () => 'kimi-boot-id');
    const runtime = { discoverSessionId } as unknown as RuntimeStrategy;
    const d = new NativeTuiDriver(makeDeps(agent, { runtime }).deps);
    await expect(d.start(undefined)).resolves.toBe('kimi-boot-id');
  });

  it('deferred id (first-turn agent, Codex): start() returns null, then late-binds', async () => {
    const agent = fakeAgent('conv-9');
    agent.spawnedSessionId = null;
    // Quick probe (1st call) finds nothing; background poll (2nd call) resolves.
    const discoverSessionId = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('codex-first-turn-id');
    const onLateBind = vi.fn();
    const runtime = { discoverSessionId } as unknown as RuntimeStrategy;
    const d = new NativeTuiDriver(makeDeps(agent, { runtime, onLateBind }).deps);

    await expect(d.start(undefined)).resolves.toBeNull();
    // Let the fire-and-forget background discovery settle.
    await vi.waitFor(() => expect(onLateBind).toHaveBeenCalledWith('codex-first-turn-id'));
    expect(discoverSessionId).toHaveBeenCalledTimes(2);
  });

  // ── LOCAL_DRIVE publishes NOTHING from the screen (2026-08-18 report) ──
  // Every PTY byte of the native TUI used to flow through the legacy
  // OutputService and get published as chat output, so mobile rendered raw
  // Claude Code chrome (box-drawing rules, `❯`, the "auto mode on (shift+tab to
  // cycle) · esc to interrupt" status line) as if the agent had said it. The
  // read-only TranscriptMirror is the ONLY source of chat content in
  // LOCAL_DRIVE.
  it('publishes ZERO chat frames from PTY bytes, even with a turn open', async () => {
    vi.useFakeTimers();
    const post = vi
      .spyOn(chunkTransport, 'post')
      .mockResolvedValue({ statusCode: 200, body: '{}' });
    try {
      const agent = fakeAgent('conv-9');
      // The REAL claude runtime, so the render + chrome/selector detection the
      // publish path runs is the production one, not a stub.
      const d = new NativeTuiDriver(
        makeDeps(agent, { runtime: createRuntimeStrategy('claude') }).deps,
      );
      await d.start();

      // A mobile-routed prompt opens a turn on the legacy PTY pipe (the only
      // way the buffer activates in the baton) …
      await d.dispatch({
        id: 'cmd-prompt',
        sessionId: 's',
        type: 'start_task',
        payload: { prompt: 'hello' },
      } as RemoteCommand);

      // … and then the real TUI paints its chrome.
      d.handlePtyData(
        '\u001b[2J╭──────────────────────────────────────────╮\r\n' +
          '│ ❯ auto mode on (shift+tab to cycle) · esc to interrupt · ← for agents │\r\n' +
          '╰──────────────────────────────────────────╯\r\n',
      );
      // Well past the 1.5 s warm-up so the render+emit tick has run repeatedly.
      await vi.advanceTimersByTimeAsync(10_000);

      const chatPosts = post.mock.calls.filter(([url]) =>
        String(url).includes('/api/commands/output'),
      );
      expect(chatPosts).toEqual([]);
    } finally {
      vi.useRealTimers();
      post.mockRestore();
    }
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
