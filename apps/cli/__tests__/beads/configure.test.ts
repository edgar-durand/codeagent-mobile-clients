import { configureBeads } from '../../src/beads/configure';

const baseProbe = { bdAvailable: true, doltAvailable: true, serverUp: true, prefix: 'proj_abc' };
function makeDeps(over = {}) {
  return {
    provision: vi.fn().mockResolvedValue(baseProbe),
    startWatcher: vi.fn().mockResolvedValue(undefined),
    stopWatcher: vi.fn().mockResolvedValue(undefined),
    probe: vi.fn().mockResolvedValue(baseProbe),
    revertAgentHook: vi.fn().mockResolvedValue(undefined),
    persist: vi.fn(),
    emit: vi.fn(),
    ...over,
  };
}
const ctx = { agent: 'claude', cwd: '/repo', pluginAuthToken: 't' };

describe('configureBeads', () => {
  it('status derives from probe without mutating', async () => {
    const d = makeDeps();
    const r = await configureBeads('status', ctx, d);
    expect(d.provision).not.toHaveBeenCalled();
    expect(r).toMatchObject({ running: true, serverUp: true });
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'beads_status' }));
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
