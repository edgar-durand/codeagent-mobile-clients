import { describe, it, expect, vi, afterEach } from 'vitest';
import * as orchestrator from '../../src/beads';
import {
  provisionBeadsForStart,
  beadsActionFromPayload,
  type BeadsSessionContext,
} from '../../src/beads/wiring';
import type { StartedBeads } from '../../src/beads';
import * as pairing from '../../src/services/pairing.service';

const baseCtx: BeadsSessionContext = {
  sessionId: 's1',
  pluginId: 'p1',
  pluginAuthToken: 't1',
  cwd: '/repo',
};

function fakeStarted(): StartedBeads {
  return { watcher: {}, adapter: {} } as unknown as StartedBeads;
}

describe('provisionBeadsForStart — composition-root entry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CODEAM_BEADS_DISABLED;
  });

  it('invokes the orchestrator with the session creds (permanently ON)', async () => {
    const spy = vi.spyOn(orchestrator, 'startBeads').mockResolvedValue(fakeStarted());
    vi.spyOn(pairing, 'postBeadsProvisioning').mockResolvedValue({ ok: true });
    await provisionBeadsForStart(baseCtx);
    expect(spy).toHaveBeenCalledTimes(1);
    const opts = spy.mock.calls[0][0];
    expect(opts.sessionId).toBe('s1');
    expect(opts.pluginId).toBe('p1');
    expect(opts.pluginAuthToken).toBe('t1');
    expect(opts.cwd).toBe('/repo');
  });

  it('returns the StartedBeads the orchestrator produced', async () => {
    const started = fakeStarted();
    vi.spyOn(orchestrator, 'startBeads').mockResolvedValue(started);
    vi.spyOn(pairing, 'postBeadsProvisioning').mockResolvedValue({ ok: true });
    const res = await provisionBeadsForStart(baseCtx);
    expect(res).toBe(started);
  });

  it('is a full no-op (orchestrator NOT called) when CODEAM_BEADS_DISABLED is truthy', async () => {
    process.env.CODEAM_BEADS_DISABLED = '1';
    const spy = vi.spyOn(orchestrator, 'startBeads');
    const signal = vi.spyOn(pairing, 'postBeadsProvisioning');
    const res = await provisionBeadsForStart(baseCtx);
    expect(res).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
  });

  it('swallows a provisioner throw non-fatally (returns null, never rejects)', async () => {
    vi.spyOn(orchestrator, 'startBeads').mockRejectedValue(new Error('bd init blew up'));
    const signal = vi.spyOn(pairing, 'postBeadsProvisioning').mockResolvedValue({ ok: true });
    const res = await provisionBeadsForStart(baseCtx);
    expect(res).toBeNull();
    // Even on a throw, we still signal `failed` so the backend stops waiting.
    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal.mock.calls[0][0].status).toBe('failed');
  });

  it('requires a pluginAuthToken — no token means no beads + no signal', async () => {
    const spy = vi.spyOn(orchestrator, 'startBeads');
    const signal = vi.spyOn(pairing, 'postBeadsProvisioning');
    const res = await provisionBeadsForStart({ ...baseCtx, pluginAuthToken: undefined });
    expect(res).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
  });

  it('signals `ready` when the watcher started', async () => {
    vi.spyOn(orchestrator, 'startBeads').mockResolvedValue(fakeStarted());
    const signal = vi.spyOn(pairing, 'postBeadsProvisioning').mockResolvedValue({ ok: true });
    await provisionBeadsForStart(baseCtx);
    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal.mock.calls[0][0].status).toBe('ready');
  });

  it('signals `failed` when provisioning yielded no watcher', async () => {
    vi.spyOn(orchestrator, 'startBeads').mockResolvedValue(null);
    const signal = vi.spyOn(pairing, 'postBeadsProvisioning').mockResolvedValue({ ok: true });
    await provisionBeadsForStart(baseCtx);
    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal.mock.calls[0][0].status).toBe('failed');
  });

  it('a non-ok provisioning signal POST does not throw (strictly non-fatal)', async () => {
    vi.spyOn(orchestrator, 'startBeads').mockResolvedValue(fakeStarted());
    vi.spyOn(pairing, 'postBeadsProvisioning').mockResolvedValue({
      ok: false,
      status: 500,
      message: 'boom',
    });
    await expect(provisionBeadsForStart(baseCtx)).resolves.not.toThrow();
  });
});

describe('beadsActionFromPayload — {action,args} → BeadsActionPayload', () => {
  it('maps a close action with reason', () => {
    const out = beadsActionFromPayload({ action: 'close', args: { issueId: 'bd-1', reason: 'done' } });
    expect(out).toEqual({ kind: 'close', issueId: 'bd-1', reason: 'done' });
  });

  it('maps a claim action with owner', () => {
    const out = beadsActionFromPayload({ action: 'claim', args: { issueId: 'bd-2', owner: 'agent-x' } });
    expect(out).toEqual({ kind: 'claim', issueId: 'bd-2', owner: 'agent-x' });
  });

  it('maps create / remember text', () => {
    expect(beadsActionFromPayload({ action: 'create', args: { text: 'New' } })).toEqual({
      kind: 'create',
      text: 'New',
    });
    expect(beadsActionFromPayload({ action: 'remember', args: { text: 'note' } })).toEqual({
      kind: 'remember',
      text: 'note',
    });
  });

  it('returns null for an unknown action', () => {
    expect(beadsActionFromPayload({ action: 'frobnicate', args: {} })).toBeNull();
  });

  it('returns null when action is missing', () => {
    expect(beadsActionFromPayload({ args: { issueId: 'x' } })).toBeNull();
  });
});
