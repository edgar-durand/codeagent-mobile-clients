import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as orchestrator from '../../src/beads';
import {
  startBeadsForSession,
  beadsActionFromPayload,
  type BeadsSessionContext,
} from '../../src/beads/wiring';
import type { StartedBeads } from '../../src/beads';
import type { AgentId } from '@codeagent/shared';

const baseCtx: BeadsSessionContext = {
  sessionId: 's1',
  pluginId: 'p1',
  pluginAuthToken: 't1',
  agents: ['claude'] as AgentId[],
  cwd: '/repo',
};

describe('startBeadsForSession — always-on wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CODEAM_BEADS_DISABLED;
  });

  it('invokes maybeStartBeads with enabled:true on start (permanently ON)', async () => {
    const spy = vi
      .spyOn(orchestrator, 'maybeStartBeads')
      .mockResolvedValue(null);
    await startBeadsForSession(baseCtx);
    expect(spy).toHaveBeenCalledTimes(1);
    const opts = spy.mock.calls[0][0];
    expect(opts.enabled).toBe(true);
    expect(opts.sessionId).toBe('s1');
    expect(opts.pluginId).toBe('p1');
    expect(opts.pluginAuthToken).toBe('t1');
    expect(opts.agents).toEqual(['claude']);
    expect(opts.cwd).toBe('/repo');
  });

  it('returns the StartedBeads the orchestrator produced', async () => {
    const started = { watcher: {}, adapter: {} } as unknown as StartedBeads;
    vi.spyOn(orchestrator, 'maybeStartBeads').mockResolvedValue(started);
    const res = await startBeadsForSession(baseCtx);
    expect(res).toBe(started);
  });

  it('is a full no-op (does NOT call the orchestrator) when CODEAM_BEADS_DISABLED is truthy', async () => {
    process.env.CODEAM_BEADS_DISABLED = '1';
    const spy = vi.spyOn(orchestrator, 'maybeStartBeads');
    const res = await startBeadsForSession(baseCtx);
    expect(res).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('swallows a bootstrap throw non-fatally (returns null, never rejects)', async () => {
    vi.spyOn(orchestrator, 'maybeStartBeads').mockRejectedValue(
      new Error('dolt would not start'),
    );
    const res = await startBeadsForSession(baseCtx);
    expect(res).toBeNull();
  });

  it('requires a pluginAuthToken — no token means no beads (auth cannot be satisfied)', async () => {
    const spy = vi.spyOn(orchestrator, 'maybeStartBeads');
    const res = await startBeadsForSession({ ...baseCtx, pluginAuthToken: undefined });
    expect(res).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('beadsActionFromPayload — {action,args} → BeadsActionPayload', () => {
  it('maps a close action with reason', () => {
    const out = beadsActionFromPayload({
      action: 'close',
      args: { issueId: 'bd-1', reason: 'done' },
    });
    expect(out).toEqual({ kind: 'close', issueId: 'bd-1', reason: 'done' });
  });

  it('maps a claim action with owner', () => {
    const out = beadsActionFromPayload({
      action: 'claim',
      args: { issueId: 'bd-2', owner: 'agent-x' },
    });
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
