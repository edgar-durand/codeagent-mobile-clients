import { describe, it, expect, vi } from 'vitest';
import { BatonController } from '../../src/baton/baton-controller';
import type { SessionDriver, DriverKind } from '../../src/baton/types';

function fakeDriver(
  kind: DriverKind,
  id: string,
  opts: { failStart?: boolean } = {},
): SessionDriver & {
  startSpy: ReturnType<typeof vi.fn>;
  stopSpy: ReturnType<typeof vi.fn>;
  releaseYield: () => void;
} {
  let resolveYield: () => void = () => {};
  const startSpy = vi.fn(async (resumeId?: string) => {
    if (opts.failStart) throw new Error(`${kind} start failed`);
    return resumeId ?? id;
  });
  const stopSpy = vi.fn(async () => {});
  return {
    kind,
    startSpy,
    stopSpy,
    start: startSpy,
    stop: stopSpy,
    dispatch: vi.fn(async () => {}),
    whenSafeToYield: () => new Promise<void>((r) => (resolveYield = r)),
    releaseYield: () => resolveYield(),
  };
}

describe('BatonController', () => {
  it('begins in LOCAL_DRIVE and captures the conversation id', async () => {
    const local = fakeDriver('local_tui', 'conv-1');
    const mobile = fakeDriver('mobile_acp', 'conv-1');
    const publishState = vi.fn();
    const c = new BatonController({ local, mobile, publishState });
    await c.begin();
    expect(local.startSpy).toHaveBeenCalledWith(undefined);
    expect(c.state).toBe('LOCAL_DRIVE');
    expect(c.conversationId).toBe('conv-1');
    expect(publishState).toHaveBeenLastCalledWith('LOCAL_DRIVE', 'local_tui', 'conv-1');
  });

  it('take-control waits for a safe yield, stops local, resumes the SAME id on mobile', async () => {
    const local = fakeDriver('local_tui', 'conv-1');
    const mobile = fakeDriver('mobile_acp', 'conv-1');
    const c = new BatonController({ local, mobile, publishState: vi.fn() });
    await c.begin();
    const p = c.takeControl();
    expect(c.state).toBe('SWITCHING');
    expect(local.stopSpy).not.toHaveBeenCalled(); // still waiting for the turn boundary
    local.releaseYield();
    await p;
    expect(local.stopSpy).toHaveBeenCalledTimes(1);
    expect(mobile.startSpy).toHaveBeenCalledWith('conv-1'); // resume, not fresh
    expect(c.state).toBe('MOBILE_DRIVE');
    expect(c.activeDriver).toBe('mobile_acp');
  });

  it('activeSessionDriver tracks the live driver object across a take-control', async () => {
    const local = fakeDriver('local_tui', 'conv-1');
    const mobile = fakeDriver('mobile_acp', 'conv-1');
    const c = new BatonController({ local, mobile, publishState: vi.fn() });
    await c.begin();
    expect(c.activeSessionDriver).toBe(local); // baton starts local
    const p = c.takeControl();
    local.releaseYield();
    await p;
    expect(c.activeSessionDriver).toBe(mobile); // flipped after hand-off
  });

  it('handback yields mobile then relaunches local with the same id', async () => {
    const local = fakeDriver('local_tui', 'conv-1');
    const mobile = fakeDriver('mobile_acp', 'conv-1');
    const c = new BatonController({ local, mobile, publishState: vi.fn() });
    await c.begin();
    const p1 = c.takeControl();
    local.releaseYield();
    await p1;
    const p2 = c.handback();
    mobile.releaseYield();
    await p2;
    expect(mobile.stopSpy).toHaveBeenCalledTimes(1);
    expect(local.startSpy).toHaveBeenLastCalledWith('conv-1');
    expect(c.state).toBe('LOCAL_DRIVE');
  });

  it('ignores take-control unless in LOCAL_DRIVE (single-driver invariant)', async () => {
    const local = fakeDriver('local_tui', 'conv-1');
    const mobile = fakeDriver('mobile_acp', 'conv-1');
    const c = new BatonController({ local, mobile, publishState: vi.fn() });
    await c.begin();
    const p = c.takeControl();
    await c.takeControl(); // second call while SWITCHING: no-op
    local.releaseYield();
    await p;
    expect(mobile.startSpy).toHaveBeenCalledTimes(1);
  });

  it('recovers from a driver throwing mid-handoff instead of wedging in SWITCHING', async () => {
    const local = fakeDriver('local_tui', 'conv-1');
    const mobileOpts: { failStart?: boolean } = { failStart: true };
    const mobile = fakeDriver('mobile_acp', 'conv-1', mobileOpts);
    const publishState = vi.fn();
    const c = new BatonController({ local, mobile, publishState });
    await c.begin();

    const p = c.takeControl();
    local.releaseYield();
    await expect(p).rejects.toThrow();

    // Not stuck 'SWITCHING' — reverted to the pre-switch steady state.
    expect(c.state).toBe('LOCAL_DRIVE');
    expect(c.activeDriver).toBe('local_tui');
    expect(publishState).toHaveBeenLastCalledWith('LOCAL_DRIVE', 'local_tui', 'conv-1');

    // A subsequent take-control with a now-working mobile driver succeeds.
    mobileOpts.failStart = false;
    const p2 = c.takeControl();
    local.releaseYield();
    await p2;
    expect(c.state).toBe('MOBILE_DRIVE');
    expect(c.activeDriver).toBe('mobile_acp');
  });

  // ── Bounded hand-off (2026-08-18 "Switching…" incident) ──────────────
  // The live failure was a driver that resolved NEITHER way: the ACP adapter's
  // `session/load` never answered, so `takeControl` sat in `SWITCHING` for the
  // rest of the session (mobile latched on "Switching…", every later
  // take/handback silently no-op'd on the `_state !== from` guard).
  it('times out a hung hand-off, reverts to the steady state, and revives the stopped driver', async () => {
    const local = fakeDriver('local_tui', 'conv-1');
    const mobile = fakeDriver('mobile_acp', 'conv-1');
    // Never settles — exactly what the wedged adapter did.
    mobile.start = vi.fn(async () => new Promise<string>(() => {}));
    const publishState = vi.fn();
    const c = new BatonController({ local, mobile, publishState, switchTimeoutMs: 40 });
    await c.begin();

    const p = c.takeControl();
    local.releaseYield();
    await expect(p).rejects.toThrow(/BATON_SWITCH_TIMEOUT/);

    // Not wedged: reverted to LOCAL_DRIVE and published, so mobile leaves
    // "Switching…" instead of latching on it forever.
    expect(c.state).toBe('LOCAL_DRIVE');
    expect(c.activeDriver).toBe('local_tui');
    expect(publishState).toHaveBeenLastCalledWith('LOCAL_DRIVE', 'local_tui', 'conv-1');
    // The half-started driver is stopped, and the native TUI (already killed
    // by the hand-off) is brought back on the same conversation — a bare state
    // revert would leave the user with a dead terminal.
    expect(mobile.stopSpy).toHaveBeenCalled();
    expect(local.startSpy).toHaveBeenLastCalledWith('conv-1');
  });

  it('a later take-control still works after a timed-out one (state was not wedged)', async () => {
    const local = fakeDriver('local_tui', 'conv-1');
    const mobile = fakeDriver('mobile_acp', 'conv-1');
    const workingStart = mobile.start;
    mobile.start = vi.fn(async () => new Promise<string>(() => {}));
    const c = new BatonController({ local, mobile, publishState: vi.fn(), switchTimeoutMs: 40 });
    await c.begin();
    const p = c.takeControl();
    local.releaseYield();
    await expect(p).rejects.toThrow();

    mobile.start = workingStart;
    const p2 = c.takeControl();
    local.releaseYield();
    await p2;
    expect(c.state).toBe('MOBILE_DRIVE');
  });

  describe('rebindConversation (late-bind, Codex first-turn id)', () => {
    function deferredLocal(): SessionDriver {
      // Fresh start resolves null (id not minted until the first turn); resume
      // returns the given id.
      return {
        kind: 'local_tui',
        start: vi.fn(async (resumeId?: string) => resumeId ?? null),
        stop: vi.fn(async () => {}),
        dispatch: vi.fn(async () => {}),
        whenSafeToYield: vi.fn(async () => {}),
      };
    }

    it('begins in LOCAL_DRIVE with a null conversation id, then late-binds it', async () => {
      const local = deferredLocal();
      const mobile = fakeDriver('mobile_acp', 'm');
      const publishState = vi.fn();
      const c = new BatonController({ local, mobile, publishState });

      await c.begin();
      expect(c.conversationId).toBeNull();
      expect(publishState).toHaveBeenLastCalledWith('LOCAL_DRIVE', 'local_tui', null);

      c.rebindConversation('codex-abc');
      expect(c.conversationId).toBe('codex-abc');
      // Re-published LOCAL_DRIVE with the now-known id so the mirror can arm.
      expect(publishState).toHaveBeenLastCalledWith('LOCAL_DRIVE', 'local_tui', 'codex-abc');
    });

    it('is a no-op once an id is already set (never clobbers a live conversation)', async () => {
      const local = deferredLocal();
      const c = new BatonController({
        local,
        mobile: fakeDriver('mobile_acp', 'm'),
        publishState: vi.fn(),
      });
      await c.begin();
      c.rebindConversation('first');
      c.rebindConversation('second'); // ignored — already bound
      expect(c.conversationId).toBe('first');
    });

    it('is a no-op when not in LOCAL_DRIVE (e.g. user already took control)', async () => {
      const local = deferredLocal();
      const mobile = fakeDriver('mobile_acp', 'mobile-fresh');
      const c = new BatonController({ local, mobile, publishState: vi.fn() });
      await c.begin(); // conversationId = null
      await c.takeControl(); // mobile.start(undefined) → 'mobile-fresh'
      expect(c.state).toBe('MOBILE_DRIVE');
      c.rebindConversation('stray-native-id'); // must NOT clobber
      expect(c.conversationId).toBe('mobile-fresh');
    });
  });

  describe('switchConversation (native TUI `/clear` → new conversation id)', () => {
    it('re-points the conversation and re-publishes LOCAL_DRIVE so the mirror re-arms', async () => {
      const local = fakeDriver('local_tui', 'conv-1');
      const mobile = fakeDriver('mobile_acp', 'm');
      const publishState = vi.fn();
      const c = new BatonController({ local, mobile, publishState });
      await c.begin();
      expect(c.conversationId).toBe('conv-1');

      c.switchConversation('conv-2'); // the TUI ran /clear
      expect(c.conversationId).toBe('conv-2');
      expect(c.state).toBe('LOCAL_DRIVE');
      expect(publishState).toHaveBeenLastCalledWith('LOCAL_DRIVE', 'local_tui', 'conv-2');
    });

    it('Take Control after the switch resumes the NEW conversation', async () => {
      const local = fakeDriver('local_tui', 'conv-1');
      const mobile = fakeDriver('mobile_acp', 'm');
      const c = new BatonController({ local, mobile, publishState: vi.fn() });
      await c.begin();
      c.switchConversation('conv-2');
      const p = c.takeControl();
      local.releaseYield();
      await p;
      expect(mobile.startSpy).toHaveBeenCalledWith('conv-2');
      expect(c.conversationId).toBe('conv-2');
    });

    it('is a no-op for the same id, and outside LOCAL_DRIVE', async () => {
      const local = fakeDriver('local_tui', 'conv-1');
      const mobile = fakeDriver('mobile_acp', 'mobile-fresh');
      const publishState = vi.fn();
      const c = new BatonController({ local, mobile, publishState });
      await c.begin();
      const publishes = publishState.mock.calls.length;
      c.switchConversation('conv-1');
      expect(publishState.mock.calls.length).toBe(publishes); // nothing re-published

      const p = c.takeControl();
      local.releaseYield();
      await p;
      expect(c.state).toBe('MOBILE_DRIVE');
      c.switchConversation('stray'); // the terminal isn't driving — ignore
      expect(c.conversationId).toBe('conv-1');
    });
  });
});
