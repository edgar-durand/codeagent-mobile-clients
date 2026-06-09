import { describe, it, expect, vi, afterEach } from 'vitest';
import { maybeStartBeads, handleBeadsActionCommand } from '../../src/beads';
import * as adapterMod from '../../src/beads/bd-adapter';
import * as bootstrapMod from '../../src/beads/bootstrap';
import * as installMod from '../../src/beads/install-bd';
import * as watcherMod from '../../src/beads/watcher';
import * as applyMod from '../../src/beads/apply-actions';
import type { AgentId } from '@codeagent/shared';

const baseOpts = {
  sessionId: 's1',
  pluginId: 'p1',
  pluginAuthToken: 't1',
  agents: ['claude'] as AgentId[],
  cwd: '/repo',
};

describe('maybeStartBeads gating', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is a complete no-op when the flag is off (no bd resolution at all)', async () => {
    const ctor = vi.spyOn(adapterMod, 'BdAdapter');
    const res = await maybeStartBeads({ ...baseOpts, enabled: false });
    expect(res).toBeNull();
    expect(ctor).not.toHaveBeenCalled();
  });

  it('returns null without bootstrapping when bd is unavailable and install not allowed', async () => {
    vi.spyOn(adapterMod.BdAdapter.prototype, 'isAvailable').mockReturnValue(false);
    const boot = vi.spyOn(bootstrapMod, 'bootstrapBeads');
    const install = vi.spyOn(installMod, 'installBd');
    const res = await maybeStartBeads({ ...baseOpts, enabled: true });
    expect(res).toBeNull();
    expect(install).not.toHaveBeenCalled();
    expect(boot).not.toHaveBeenCalled();
  });

  it('runs the installer (consented) when bd is missing, then bails if still unavailable', async () => {
    vi.spyOn(adapterMod.BdAdapter.prototype, 'isAvailable').mockReturnValue(false);
    const install = vi
      .spyOn(installMod, 'installBd')
      .mockResolvedValue({ ok: false, code: 1, stderr: 'x' });
    const res = await maybeStartBeads({ ...baseOpts, enabled: true, allowInstall: true });
    expect(install).toHaveBeenCalledTimes(1);
    expect(res).toBeNull();
  });

  it('bootstraps + starts the watcher when bd is available and the server comes up', async () => {
    vi.spyOn(adapterMod.BdAdapter.prototype, 'isAvailable').mockReturnValue(true);
    vi.spyOn(bootstrapMod, 'bootstrapBeads').mockResolvedValue({
      bdAvailable: true,
      serverUp: true,
      agentsConfigured: ['claude'],
      exportEnabled: true,
    });
    const start = vi.spyOn(watcherMod.BeadsWatcher.prototype, 'start').mockImplementation(() => {});
    const sync = vi
      .spyOn(watcherMod.BeadsWatcher.prototype, 'syncNow')
      .mockResolvedValue(undefined);

    const res = await maybeStartBeads({ ...baseOpts, enabled: true });
    expect(res).not.toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1); // immediate snapshot push
  });

  it('does not start the watcher when bootstrap reports the server down', async () => {
    vi.spyOn(adapterMod.BdAdapter.prototype, 'isAvailable').mockReturnValue(true);
    vi.spyOn(bootstrapMod, 'bootstrapBeads').mockResolvedValue({
      bdAvailable: true,
      serverUp: false,
      agentsConfigured: [],
      exportEnabled: false,
    });
    const start = vi.spyOn(watcherMod.BeadsWatcher.prototype, 'start');
    const res = await maybeStartBeads({ ...baseOpts, enabled: true });
    expect(res).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });
});

describe('handleBeadsActionCommand', () => {
  afterEach(() => vi.restoreAllMocks());

  it('applies the action against the live adapter + pushes via the watcher', async () => {
    const apply = vi
      .spyOn(applyMod, 'applyBeadsAction')
      .mockResolvedValue({ ok: true, action: 'close', code: 0 });
    const fakeWatcher = { syncNow: vi.fn().mockResolvedValue(undefined) };
    const started = {
      watcher: fakeWatcher as never,
      adapter: {} as never,
    };
    await handleBeadsActionCommand({ kind: 'close', issueId: 'bd-1' }, started);
    expect(apply).toHaveBeenCalledTimes(1);
    // onApplied wired to the watcher's syncNow.
    const deps = apply.mock.calls[0][1];
    await deps.onApplied();
    expect(fakeWatcher.syncNow).toHaveBeenCalled();
  });
});
