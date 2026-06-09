import { describe, it, expect, vi, afterEach } from 'vitest';
import { startBeads, handleBeadsActionCommand } from '../../src/beads';
import * as adapterMod from '../../src/beads/bd-adapter';
import * as provisionerMod from '../../src/beads/provisioner';
import * as watcherMod from '../../src/beads/watcher';
import * as applyMod from '../../src/beads/apply-actions';

const baseOpts = {
  sessionId: 's1',
  pluginId: 'p1',
  pluginAuthToken: 't1',
  cwd: '/repo',
};

describe('startBeads — composition-root orchestrator', () => {
  afterEach(() => vi.restoreAllMocks());

  it('starts the watcher + pushes an immediate snapshot when provisioning succeeds', async () => {
    vi.spyOn(provisionerMod, 'provisionBeads').mockResolvedValue({
      bdAvailable: true,
      initialized: true,
      exportEnabled: true,
    });
    const start = vi.spyOn(watcherMod.BeadsWatcher.prototype, 'start').mockImplementation(() => {});
    const sync = vi
      .spyOn(watcherMod.BeadsWatcher.prototype, 'syncNow')
      .mockResolvedValue(undefined);

    const res = await startBeads(baseOpts);

    expect(res).not.toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1); // immediate snapshot push
  });

  it('does NOT start the watcher when bd could not be provisioned', async () => {
    vi.spyOn(provisionerMod, 'provisionBeads').mockResolvedValue({
      bdAvailable: false,
      initialized: false,
      exportEnabled: false,
    });
    const start = vi.spyOn(watcherMod.BeadsWatcher.prototype, 'start');

    const res = await startBeads(baseOpts);

    expect(res).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it('does NOT start the watcher when the home brain failed to initialize', async () => {
    vi.spyOn(provisionerMod, 'provisionBeads').mockResolvedValue({
      bdAvailable: true,
      initialized: false,
      exportEnabled: false,
    });
    const start = vi.spyOn(watcherMod.BeadsWatcher.prototype, 'start');

    const res = await startBeads(baseOpts);

    expect(res).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it('passes the adapter it built into the provisioner (shared resolved binary)', async () => {
    const provision = vi.spyOn(provisionerMod, 'provisionBeads').mockResolvedValue({
      bdAvailable: false,
      initialized: false,
      exportEnabled: false,
    });
    await startBeads(baseOpts);
    expect(provision).toHaveBeenCalledTimes(1);
    const passed = provision.mock.calls[0][0];
    expect(passed?.adapter).toBeInstanceOf(adapterMod.BdAdapter);
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
