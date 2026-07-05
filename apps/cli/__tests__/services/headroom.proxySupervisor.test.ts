/**
 * Headroom proxy supervisor — keeps :8787 alive for the session.
 *
 * The bug (2026-07-04): a codespace's Headroom proxy died mid-session (the
 * backend only relaunches it on a full wake bootstrap), so every turn hung
 * 90s with "adapter sent no updates" and the greeting-then-broken pattern.
 * The CLI runs continuously, so it supervises the proxy: probe :8787/livez,
 * respawn if down — but ONLY on boxes actually routing through Headroom.
 */
import { describe, it, expect, vi } from 'vitest';
import { ensureHeadroomProxy } from '../../src/services/headroom/proxy-supervisor';

describe('ensureHeadroomProxy', () => {
  it('respawns the proxy when it is configured but not answering /livez', async () => {
    const spawnProxy = vi.fn();
    const result = await ensureHeadroomProxy({
      isConfigured: () => true,
      probeAlive: async () => false,
      spawnProxy,
    });
    expect(result).toBe('respawned');
    expect(spawnProxy).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the proxy is already alive', async () => {
    const spawnProxy = vi.fn();
    const result = await ensureHeadroomProxy({
      isConfigured: () => true,
      probeAlive: async () => true,
      spawnProxy,
    });
    expect(result).toBe('alive');
    expect(spawnProxy).not.toHaveBeenCalled();
  });

  it('skips entirely when Headroom is not configured (native/disabled boxes)', async () => {
    const spawnProxy = vi.fn();
    const probeAlive = vi.fn(async () => false);
    const result = await ensureHeadroomProxy({
      isConfigured: () => false,
      probeAlive,
      spawnProxy,
    });
    expect(result).toBe('skip');
    expect(probeAlive).not.toHaveBeenCalled();
    expect(spawnProxy).not.toHaveBeenCalled();
  });

  it('treats a probe that throws as down and respawns', async () => {
    const spawnProxy = vi.fn();
    const result = await ensureHeadroomProxy({
      isConfigured: () => true,
      probeAlive: async () => {
        throw new Error('ECONNREFUSED');
      },
      spawnProxy,
    });
    expect(result).toBe('respawned');
    expect(spawnProxy).toHaveBeenCalledTimes(1);
  });
});
