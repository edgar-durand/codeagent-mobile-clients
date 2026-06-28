import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureBeads, probeBeadsStatus, _probeSeam } from '../../src/beads/configure';

const baseProbe = { bdAvailable: true, doltAvailable: true, serverUp: true, prefix: 'proj_abc' };
function makeDeps(over = {}) {
  return {
    provision: vi.fn().mockResolvedValue(baseProbe),
    startWatcher: vi.fn().mockResolvedValue(undefined),
    stopWatcher: vi.fn().mockResolvedValue(undefined),
    probe: vi.fn().mockResolvedValue(baseProbe),
    revertAgentHook: vi.fn().mockResolvedValue(undefined),
    persist: vi.fn(),
    readEnabled: vi.fn().mockReturnValue(true),
    emit: vi.fn(),
    ...over,
  };
}
const ctx = { agent: 'claude', cwd: '/repo', pluginAuthToken: 't' };

describe('configureBeads', () => {
  it('status derives from probe without mutating (readEnabled=true)', async () => {
    const d = makeDeps({ readEnabled: vi.fn().mockReturnValue(true) });
    const r = await configureBeads('status', ctx, d);
    expect(d.provision).not.toHaveBeenCalled();
    expect(d.probe).toHaveBeenCalled();
    expect(r).toMatchObject({ running: true, serverUp: true });
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'beads_status' }));
  });

  it('status returns disabled immediately when readEnabled=false — does NOT call probe', async () => {
    const d = makeDeps({ readEnabled: vi.fn().mockReturnValue(false) });
    const r = await configureBeads('status', ctx, d);
    expect(d.probe).not.toHaveBeenCalled();
    expect(d.provision).not.toHaveBeenCalled();
    expect(r).toEqual({ enabled: false, running: false });
    expect(d.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'beads_status', state: 'disabled', running: false }),
    );
  });

  it('enable provisions, persists enabled, starts watcher, emits enabled', async () => {
    const d = makeDeps();
    const r = await configureBeads('enable', ctx, d);
    expect(d.persist).toHaveBeenCalledWith({ enabled: true });
    expect(d.provision).toHaveBeenCalled();
    expect(d.startWatcher).toHaveBeenCalled();
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ state: 'enabled' }));
    expect(r.enabled).toBe(true);
  });

  it('enable emits error when provision yields no server', async () => {
    const d = makeDeps({ provision: vi.fn().mockResolvedValue({ bdAvailable: false, doltAvailable: false, serverUp: false, prefix: null }) });
    const r = await configureBeads('enable', ctx, d);
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ state: 'error' }));
    expect(r.enabled).toBe(false);
  });

  it('disable persists false, stops watcher, reverts hook, does NOT stop server, emits disabled', async () => {
    const d = makeDeps();
    const r = await configureBeads('disable', ctx, d);
    expect(d.persist).toHaveBeenCalledWith({ enabled: false });
    expect(d.stopWatcher).toHaveBeenCalled();
    expect(d.revertAgentHook).toHaveBeenCalledWith('claude');
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ state: 'disabled' }));
    expect(r.enabled).toBe(false);
  });
});

// ── probeBeadsStatus ───────────────────────────────────────────────────────────

describe('probeBeadsStatus', () => {
  let origResolveBd: typeof _probeSeam.resolveBd;
  let origDoltOnPath: typeof _probeSeam.doltOnPath;
  let origPing: typeof _probeSeam.ping;
  let origDerivePrefix: typeof _probeSeam.derivePrefix;

  beforeEach(() => {
    origResolveBd = _probeSeam.resolveBd;
    origDoltOnPath = _probeSeam.doltOnPath;
    origPing = _probeSeam.ping;
    origDerivePrefix = _probeSeam.derivePrefix;
  });

  afterEach(() => {
    _probeSeam.resolveBd = origResolveBd;
    _probeSeam.doltOnPath = origDoltOnPath;
    _probeSeam.ping = origPing;
    _probeSeam.derivePrefix = origDerivePrefix;
  });

  it('returns all-true when bd, dolt, and server are available', async () => {
    _probeSeam.resolveBd = vi.fn().mockReturnValue(true);
    _probeSeam.doltOnPath = vi.fn().mockReturnValue(true);
    _probeSeam.ping = vi.fn().mockResolvedValue(true);
    _probeSeam.derivePrefix = vi.fn().mockReturnValue('proj_abc12345');

    const result = await probeBeadsStatus('/some/cwd');
    expect(result).toEqual({ bdAvailable: true, doltAvailable: true, serverUp: true, prefix: 'proj_abc12345' });
  });

  it('returns serverUp=false when bd is not available (no install attempted)', async () => {
    _probeSeam.resolveBd = vi.fn().mockReturnValue(false);
    _probeSeam.doltOnPath = vi.fn().mockReturnValue(true);
    _probeSeam.ping = vi.fn().mockResolvedValue(true);
    _probeSeam.derivePrefix = vi.fn().mockReturnValue('proj_abc12345');

    const result = await probeBeadsStatus('/some/cwd');
    expect(result.bdAvailable).toBe(false);
    expect(result.serverUp).toBe(false);
    // ping must NOT be called when bd is not available
    expect(_probeSeam.ping).not.toHaveBeenCalled();
  });

  it('returns serverUp=false when dolt is not available (no install attempted)', async () => {
    _probeSeam.resolveBd = vi.fn().mockReturnValue(true);
    _probeSeam.doltOnPath = vi.fn().mockReturnValue(false);
    _probeSeam.ping = vi.fn().mockResolvedValue(true);
    _probeSeam.derivePrefix = vi.fn().mockReturnValue('proj_abc12345');

    const result = await probeBeadsStatus('/some/cwd');
    expect(result.doltAvailable).toBe(false);
    expect(result.serverUp).toBe(false);
    // ping must NOT be called when dolt is not available
    expect(_probeSeam.ping).not.toHaveBeenCalled();
  });

  it('returns serverUp=false when ping fails (server not running)', async () => {
    _probeSeam.resolveBd = vi.fn().mockReturnValue(true);
    _probeSeam.doltOnPath = vi.fn().mockReturnValue(true);
    _probeSeam.ping = vi.fn().mockResolvedValue(false);
    _probeSeam.derivePrefix = vi.fn().mockReturnValue('proj_abc12345');

    const result = await probeBeadsStatus('/some/cwd');
    expect(result.bdAvailable).toBe(true);
    expect(result.doltAvailable).toBe(true);
    expect(result.serverUp).toBe(false);
  });

  it('returns prefix=null when prefix derivation fails', async () => {
    _probeSeam.resolveBd = vi.fn().mockReturnValue(true);
    _probeSeam.doltOnPath = vi.fn().mockReturnValue(true);
    _probeSeam.ping = vi.fn().mockResolvedValue(true);
    _probeSeam.derivePrefix = vi.fn().mockReturnValue(null);

    const result = await probeBeadsStatus('/some/cwd');
    expect(result.prefix).toBeNull();
  });

  it('never calls provision/install side-effects — only read-only seam methods', async () => {
    // This test documents the contract: probeBeadsStatus touches ONLY the three
    // read-only seam methods; it must NOT trigger any install or server-start.
    const resolveBd = vi.fn().mockReturnValue(false);
    const doltOnPath = vi.fn().mockReturnValue(false);
    const ping = vi.fn().mockResolvedValue(false);
    const derivePrefix = vi.fn().mockReturnValue(null);
    _probeSeam.resolveBd = resolveBd;
    _probeSeam.doltOnPath = doltOnPath;
    _probeSeam.ping = ping;
    _probeSeam.derivePrefix = derivePrefix;

    await probeBeadsStatus('/cold/box');

    // Only these four are called — no provisioner, no dolt install, no server start
    expect(resolveBd).toHaveBeenCalledWith('/cold/box');
    expect(doltOnPath).toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled(); // skipped when bd unavailable
    expect(derivePrefix).toHaveBeenCalledWith('/cold/box');
  });
});
