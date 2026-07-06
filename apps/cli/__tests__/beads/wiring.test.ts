import { describe, it, expect, vi, afterEach } from 'vitest';
import * as orchestrator from '../../src/beads';
import {
  provisionBeadsForStart,
  beadsActionFromPayload,
  type BeadsSessionContext,
} from '../../src/beads/wiring';
import { buildBdArgs } from '../../src/beads/apply-actions';
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
    delete process.env.BEADS_DIR;
    delete process.env.BEADS_DOLT_SHARED_SERVER;
  });

  it('exports shared-server mode + strips BEADS_DIR for the agent spawn SYNCHRONOUSLY (GAP 2)', () => {
    vi.spyOn(orchestrator, 'startBeads').mockResolvedValue(fakeStarted());
    vi.spyOn(pairing, 'postBeadsProvisioning').mockResolvedValue({ ok: true });
    process.env.BEADS_DIR = '/stale/beads'; // a stale inherited value must be cleared
    delete process.env.BEADS_DOLT_SHARED_SERVER;
    // NOT awaited — must be set before the promise resolves so the agent
    // (spawned later in the same synchronous tick) inherits it; its Bash tool
    // + the `bd prime` SessionStart hook need shared-server mode to read memory.
    // BEADS_DIR must be ABSENT — under shared-server the workspace resolves from
    // the agent's cwd; a forced BEADS_DIR breaks it.
    void provisionBeadsForStart(baseCtx);
    expect(process.env.BEADS_DOLT_SHARED_SERVER).toBe('1');
    expect(process.env.BEADS_DIR).toBeUndefined();
  });

  it('does NOT set BEADS_DIR / shared-server env when beads is killed (full no-op)', () => {
    process.env.CODEAM_BEADS_DISABLED = '1';
    delete process.env.BEADS_DIR;
    delete process.env.BEADS_DOLT_SHARED_SERVER;
    void provisionBeadsForStart(baseCtx);
    expect(process.env.BEADS_DIR).toBeUndefined();
    expect(process.env.BEADS_DOLT_SHARED_SERVER).toBeUndefined();
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

/**
 * CONTRACT FIXTURES — these payloads are byte-for-byte what the backend's
 * `buildBeadsActionCommand` (codeagent-mobile repo,
 * `apps/api-v2/src/beads/bd-action.util.ts`) pushes as the `beads_action`
 * command payload. If that util changes shape, update BOTH sides in the
 * same coordinated change. Regression guard for bd codeagent-0rh: the
 * backend used to relay `args` as a bd argv ARRAY, which decoded to
 * all-undefined fields here and every mobile Beads action was silently
 * dropped.
 */
describe('beadsActionFromPayload — backend contract fixtures (codeagent-0rh)', () => {
  it('decodes the exact backend claim payload into runnable bd argv', () => {
    const backendPayload = { action: 'claim', args: { kind: 'claim', issueId: 'bd-a1b2' } };
    const action = beadsActionFromPayload(backendPayload);
    expect(action).not.toBeNull();
    expect(buildBdArgs(action!)).toEqual(['update', 'bd-a1b2', '--claim']);
  });

  it('decodes the exact backend close payload (with reason)', () => {
    const backendPayload = {
      action: 'close',
      args: { kind: 'close', issueId: 'bd-c3d4', reason: 'duplicate' },
    };
    const action = beadsActionFromPayload(backendPayload);
    expect(buildBdArgs(action!)).toEqual(['close', 'bd-c3d4', '--reason', 'duplicate']);
  });

  it('decodes the exact backend create payload (title travels in text)', () => {
    const backendPayload = {
      action: 'create',
      args: { kind: 'create', text: 'Fix the thing', projectKey: 'github.com/acme/web' },
    };
    const action = beadsActionFromPayload(backendPayload);
    expect(buildBdArgs(action!)).toEqual(['create', 'Fix the thing']);
    expect(action!.projectKey).toBe('github.com/acme/web');
  });

  it('decodes the exact backend remember payload', () => {
    const backendPayload = {
      action: 'remember',
      args: { kind: 'remember', text: 'We use Prisma for the mirror' },
    };
    const action = beadsActionFromPayload(backendPayload);
    expect(buildBdArgs(action!)).toEqual(['remember', 'We use Prisma for the mirror']);
  });

  it('still drops the pre-fix argv-array shape instead of running a mangled command', () => {
    const legacyArgvPayload = {
      action: 'claim',
      args: ['update', 'bd-a1b2', '--status', 'in_progress'],
    };
    const action = beadsActionFromPayload(legacyArgvPayload);
    expect(action).toEqual({ kind: 'claim' }); // fields undefined stripped by decode
    expect(buildBdArgs(action!)).toBeNull(); // apply path rejects it as malformed
  });
});
