// __tests__/headroom/configure.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureHeadroom, type ConfigureDeps, type ConfigureCtx } from '../../src/services/headroom/configure';
import type { Savings } from '../../src/services/headroom/stats-reporter';

const ZERO_SAVINGS: Savings = {
  rawTokensEst: 0,
  sentTokensEst: 0,
  cachedTokens: 0,
  retrieveHops: 0,
  cacheReadTokens: 0,
  cacheSavingsUsd: 0,
  compressionTokens: 0,
  compressionSavingsUsd: 0,
  compressionPct: 0,
};

function makeCtx(overrides: Partial<ConfigureCtx> = {}): ConfigureCtx {
  return {
    agent: 'claude',
    pluginAuthToken: 'tok',
    savingsIngestUrl: 'https://example.com/savings',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ConfigureDeps> = {}): ConfigureDeps {
  return {
    setup: vi.fn().mockResolvedValue(true),
    probeStats: vi.fn().mockResolvedValue(null),
    persist: vi.fn(),
    readEnabled: vi.fn().mockReturnValue(false),
    startReporter: vi.fn(),
    stopReporter: vi.fn(),
    restoreAgentHeadroomConfig: vi.fn().mockReturnValue(true),
    stopProxy: vi.fn(),
    emit: vi.fn(),
    ...overrides,
  };
}

describe('configureHeadroom – status', () => {
  it('returns enabled=false and running=false when probe returns null', async () => {
    const ctx = makeCtx();
    const deps = makeDeps({ readEnabled: vi.fn().mockReturnValue(false), probeStats: vi.fn().mockResolvedValue(null) });
    const result = await configureHeadroom('status', ctx, deps);
    expect(result).toMatchObject({ enabled: false, running: false });
    expect(deps.probeStats).toHaveBeenCalledOnce();
  });

  it('returns enabled=true and savings when probe returns stats', async () => {
    const savings: Savings = { ...ZERO_SAVINGS, compressionTokens: 100 };
    const ctx = makeCtx();
    const deps = makeDeps({
      readEnabled: vi.fn().mockReturnValue(true),
      probeStats: vi.fn().mockResolvedValue(savings),
    });
    const result = await configureHeadroom('status', ctx, deps);
    expect(result).toMatchObject({ enabled: true, running: true, savings });
  });
});

describe('configureHeadroom – enable', () => {
  it('returns {supported:false} for unsupported agent, no setup called', async () => {
    const ctx = makeCtx({ agent: 'cursor' });
    const deps = makeDeps();
    const result = await configureHeadroom('enable', ctx, deps);
    expect(result).toEqual({ supported: false });
    expect(deps.setup).not.toHaveBeenCalled();
  });

  it('calls setup with proxy/code/image extras, persists enabled, starts reporter, emits ready', async () => {
    const ctx = makeCtx({ agent: 'claude' });
    const deps = makeDeps({ setup: vi.fn().mockResolvedValue(true) });
    const result = await configureHeadroom('enable', ctx, deps);

    expect(deps.setup).toHaveBeenCalledWith(
      'claude',
      undefined,
      expect.objectContaining({ extras: ['proxy', 'code', 'image'] }),
    );
    // onProgress wires emit
    const onProgress = (deps.setup as ReturnType<typeof vi.fn>).mock.calls[0][2].onProgress;
    onProgress('pip');
    expect(deps.emit).toHaveBeenCalledWith({ type: 'headroom_progress', step: 'pip' });

    expect(deps.persist).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    expect(deps.startReporter).toHaveBeenCalledOnce();
    expect(deps.emit).toHaveBeenCalledWith({ type: 'headroom_status', state: 'enabled' });
    expect(result).toEqual({ enabled: true });
  });

  it('emits error status and returns {enabled:false} when setup returns false', async () => {
    const ctx = makeCtx({ agent: 'claude' });
    const deps = makeDeps({ setup: vi.fn().mockResolvedValue(false) });
    const result = await configureHeadroom('enable', ctx, deps);
    expect(deps.persist).not.toHaveBeenCalled();
    expect(deps.startReporter).not.toHaveBeenCalled();
    expect(deps.emit).toHaveBeenCalledWith({ type: 'headroom_status', state: 'error' });
    expect(result).toEqual({ enabled: false });
  });
});

describe('configureHeadroom – disable', () => {
  it('calls restoreAgentHeadroomConfig BEFORE stopProxy', async () => {
    const ctx = makeCtx({ agent: 'claude' });
    const deps = makeDeps();
    const order: string[] = [];
    deps.restoreAgentHeadroomConfig = vi.fn(() => { order.push('restore'); return true; });
    deps.stopProxy = vi.fn(() => { order.push('stop'); });
    await configureHeadroom('disable', ctx, deps);
    expect(order).toEqual(['restore', 'stop']);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((deps as any).pipUninstall).toBeUndefined(); // never uninstalls
  });

  it('persists enabled:false and stops reporter', async () => {
    const ctx = makeCtx({ agent: 'claude' });
    const deps = makeDeps();
    const result = await configureHeadroom('disable', ctx, deps);
    expect(deps.persist).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(deps.stopReporter).toHaveBeenCalledOnce();
    expect(deps.emit).toHaveBeenCalledWith({ type: 'headroom_status', state: 'disabled' });
    expect(result).toEqual({ enabled: false });
  });
});
