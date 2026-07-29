/**
 * Headroom proxy supervisor — keeps :8787 alive for the session.
 *
 * The original bug (2026-07-04): a codespace's Headroom proxy died mid-session
 * (the backend only relaunches it on a full wake bootstrap), so every turn hung
 * 90s with "adapter sent no updates". The CLI runs continuously, so it
 * supervises the proxy: probe :8787/livez, respawn if down — but ONLY on boxes
 * actually routing through Headroom.
 *
 * The respawn-loop regression (2026-07-28): a proxy eager-loads the ONNX model
 * at bind time, so it's a live process that isn't answering /livez yet. The old
 * supervisor treated "not answering" as "dead" and respawned → a second
 * `headroom proxy --port 8787` → EADDRINUSE → the loop (worse with two relay
 * supervisors on one box). The fix: only respawn a proxy that is BOTH
 * pid-confirmed-dead AND past the startup grace.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ensureHeadroomProxy,
  PROXY_STARTUP_GRACE_MS,
} from '../../src/services/headroom/proxy-supervisor';

/** Baseline deps: configured, /livez down, no proxy process, never spawned. */
function deps(over: Partial<Parameters<typeof ensureHeadroomProxy>[0]> = {}) {
  return {
    isConfigured: () => true,
    probeAlive: async () => false,
    proxyProcessAlive: () => false,
    proxyStartupAgeMs: () => null,
    spawnProxy: vi.fn(),
    ...over,
  };
}

describe('ensureHeadroomProxy', () => {
  it('respawns when configured, /livez down, no live process, never spawned', async () => {
    const spawnProxy = vi.fn();
    const result = await ensureHeadroomProxy(deps({ spawnProxy }));
    expect(result).toBe('respawned');
    expect(spawnProxy).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the proxy is already alive', async () => {
    const spawnProxy = vi.fn();
    const result = await ensureHeadroomProxy(deps({ probeAlive: async () => true, spawnProxy }));
    expect(result).toBe('alive');
    expect(spawnProxy).not.toHaveBeenCalled();
  });

  it('skips entirely when Headroom is not configured (native/disabled boxes)', async () => {
    const spawnProxy = vi.fn();
    const probeAlive = vi.fn(async () => false);
    const result = await ensureHeadroomProxy(
      deps({ isConfigured: () => false, probeAlive, spawnProxy }),
    );
    expect(result).toBe('skip');
    expect(probeAlive).not.toHaveBeenCalled();
    expect(spawnProxy).not.toHaveBeenCalled();
  });

  it('does NOT respawn a live-but-not-yet-answering proxy (model still loading)', async () => {
    // The regression case: process is up (pid alive) but /livez times out
    // because the ONNX model is still preloading. Respawning here is the loop.
    const spawnProxy = vi.fn();
    const result = await ensureHeadroomProxy(
      deps({ proxyProcessAlive: () => true, spawnProxy }),
    );
    expect(result).toBe('starting');
    expect(spawnProxy).not.toHaveBeenCalled();
  });

  it('does NOT respawn within the startup grace even if the pid looks dead', async () => {
    // Just-spawned proxy: pid may not have registered yet, but we spawned it
    // recently, so give it time rather than piling on a second spawn.
    const spawnProxy = vi.fn();
    const result = await ensureHeadroomProxy(
      deps({ proxyStartupAgeMs: () => PROXY_STARTUP_GRACE_MS - 1_000, spawnProxy }),
    );
    expect(result).toBe('starting');
    expect(spawnProxy).not.toHaveBeenCalled();
  });

  it('respawns a confirmed-dead proxy once the startup grace has elapsed', async () => {
    const spawnProxy = vi.fn();
    const result = await ensureHeadroomProxy(
      deps({ proxyStartupAgeMs: () => PROXY_STARTUP_GRACE_MS + 1_000, spawnProxy }),
    );
    expect(result).toBe('respawned');
    expect(spawnProxy).toHaveBeenCalledTimes(1);
  });

  it('treats a probe that throws as down (still gated by pid + grace)', async () => {
    const spawnProxy = vi.fn();
    const result = await ensureHeadroomProxy(
      deps({
        probeAlive: async () => {
          throw new Error('ECONNREFUSED');
        },
        spawnProxy,
      }),
    );
    // No live process + never spawned → confirmed dead → respawn.
    expect(result).toBe('respawned');
    expect(spawnProxy).toHaveBeenCalledTimes(1);
  });

  it('a thrown probe on a live-but-warming proxy still does NOT respawn', async () => {
    const spawnProxy = vi.fn();
    const result = await ensureHeadroomProxy(
      deps({
        probeAlive: async () => {
          throw new Error('ECONNREFUSED');
        },
        proxyProcessAlive: () => true,
        spawnProxy,
      }),
    );
    expect(result).toBe('starting');
    expect(spawnProxy).not.toHaveBeenCalled();
  });
});
