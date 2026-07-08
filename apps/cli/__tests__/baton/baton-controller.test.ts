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
});
