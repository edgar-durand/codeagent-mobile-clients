/**
 * Rafael 2026-08-08: on a warm-codespace resume the detached Headroom :8787
 * proxy got SIGTERM'd and was NOT relaunched, so claude's
 * ANTHROPIC_BASE_URL=127.0.0.1:8787 → every turn "ConnectionRefused" for ~9 min
 * until the 30s heartbeat supervisor happened to respawn it. ensureHeadroomProxyReady
 * closes the gap by (re)spawning + WAITING for /livez right before a turn.
 * These lock the contract: no-op when not configured / already alive; force-spawn
 * + wait when down; give up (proceed) after the bounded wait.
 */
import { describe, it, expect, vi } from 'vitest';
import { ensureHeadroomProxyReady } from '../../../src/services/headroom/proxy-supervisor';

const noSleep = () => Promise.resolve();

function deps(over: Partial<Parameters<typeof ensureHeadroomProxyReady>[0]>) {
  return {
    isConfigured: () => true,
    probeAlive: async () => false,
    proxyProcessAlive: () => false,
    proxyStartupAgeMs: () => null,
    spawnProxy: vi.fn(),
    spawnProxyForce: vi.fn(),
    ...over,
  };
}

describe('ensureHeadroomProxyReady', () => {
  it('is a no-op when Headroom is not configured (never probes/spawns)', async () => {
    const probeAlive = vi.fn(async () => false);
    const spawnProxyForce = vi.fn();
    const ok = await ensureHeadroomProxyReady(deps({ isConfigured: () => false, probeAlive, spawnProxyForce }));
    expect(ok).toBe(true);
    expect(probeAlive).not.toHaveBeenCalled();
    expect(spawnProxyForce).not.toHaveBeenCalled();
  });

  it('is a cheap no-op when the proxy already answers /livez (no respawn)', async () => {
    const spawnProxyForce = vi.fn();
    const ok = await ensureHeadroomProxyReady(deps({ probeAlive: async () => true, spawnProxyForce }));
    expect(ok).toBe(true);
    expect(spawnProxyForce).not.toHaveBeenCalled();
  });

  it('force-respawns and WAITS for /livez when the proxy is down, then succeeds', async () => {
    const spawnProxyForce = vi.fn();
    let calls = 0;
    // down at first probe → respawn → down once more → then up.
    const probeAlive = vi.fn(async () => {
      calls += 1;
      return calls >= 3; // initial(false) + poll1(false) + poll2(true)
    });
    const ok = await ensureHeadroomProxyReady(
      deps({ probeAlive, spawnProxyForce }),
      { sleep: noSleep, pollMs: 1000, timeoutMs: 10_000 },
    );
    expect(ok).toBe(true);
    expect(spawnProxyForce).toHaveBeenCalledTimes(1);
  });

  it('falls back to spawnProxy when spawnProxyForce is absent', async () => {
    const spawnProxy = vi.fn();
    const ok = await ensureHeadroomProxyReady(
      { isConfigured: () => true, probeAlive: async () => false, proxyProcessAlive: () => false, proxyStartupAgeMs: () => null, spawnProxy },
      { sleep: noSleep, pollMs: 1000, timeoutMs: 1000 },
    );
    expect(spawnProxy).toHaveBeenCalledTimes(1);
    expect(ok).toBe(false); // never came up within the bounded wait
  });

  it('gives up (returns false) after the bounded wait so the turn still proceeds', async () => {
    const ok = await ensureHeadroomProxyReady(
      deps({ probeAlive: async () => false }),
      { sleep: noSleep, pollMs: 1000, timeoutMs: 3000 },
    );
    expect(ok).toBe(false);
  });
});
