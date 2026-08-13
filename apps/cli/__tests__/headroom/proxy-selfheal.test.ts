import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  isHeadroomConfiguredReal,
  ensureHeadroomProxy,
  type ProxySupervisorDeps,
} from '../../src/services/headroom/proxy-supervisor';

/**
 * Regression suite for the 2026-08-13 incident: a codespace whose Headroom
 * proxy died and stayed dead ~9 minutes while EVERY turn failed
 * `API Error: Unable to connect to API (ConnectionRefused)`.
 *
 * Two independent defects, one test group each. Both are OURS.
 */

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-selfheal-'));
  fs.mkdirSync(path.join(home, '.codeam'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  delete process.env.HEADROOM_ENABLED;
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.HEADROOM_ENABLED;
});

describe('isHeadroomConfiguredReal — the gate on the pre-turn self-heal', () => {
  it('trusts OUR OWN headroom-config.json even when every third-party signal is absent', () => {
    // THE INCIDENT: headroom >= 0.33 stopped writing `127.0.0.1:8787` into
    // ~/.claude/settings.json (it routes via a PreToolUse hook), and this box
    // had no HEADROOM_* env and no codespace-env.json key. All three legacy
    // signals said "not configured" → the pre-turn heal silently no-op'd
    // (`pre-turn heals: 0` across 6 prompts / 3 ConnectionRefused) while the
    // proxy was down. Our own persisted state said `enabled: true` the whole
    // time and was never consulted.
    fs.writeFileSync(
      path.join(home, '.codeam', 'headroom-config.json'),
      JSON.stringify({ enabled: true, agent: 'claude' }),
    );
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));

    expect(isHeadroomConfiguredReal(home)).toBe(true);
  });

  it('recognises the headroom >= 0.33 HOOK layout in settings.json', () => {
    fs.writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { hooks: [{ command: '/usr/local/bin/headroom init hook ensure --profile init-user' }] },
          ],
        },
      }),
    );
    expect(isHeadroomConfiguredReal(home)).toBe(true);
  });

  it('still honours the legacy base-URL layout and the env flag', () => {
    fs.writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' } }),
    );
    expect(isHeadroomConfiguredReal(home)).toBe(true);

    fs.rmSync(path.join(home, '.claude', 'settings.json'));
    expect(isHeadroomConfiguredReal(home)).toBe(false);
    process.env.HEADROOM_ENABLED = '1';
    expect(isHeadroomConfiguredReal(home)).toBe(true);
  });

  it('is false only when Headroom genuinely is not set up here', () => {
    fs.writeFileSync(
      path.join(home, '.codeam', 'headroom-config.json'),
      JSON.stringify({ enabled: false }),
    );
    expect(isHeadroomConfiguredReal(home)).toBe(false);
  });
});

describe('ensureHeadroomProxy — adopt a healthy proxy instead of killing it', () => {
  function deps(over: Partial<ProxySupervisorDeps> = {}): ProxySupervisorDeps {
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

  it('ADOPTS a running proxy we did not spawn — never respawns over it', async () => {
    // A proxy launched by the codespace bootstrap shell has no pidfile of
    // ours, so every liveness check reads "dead". Pre-fix the supervisor then
    // force-respawned, and `killHeadroomProxy`'s blind
    // `pkill -f 'headroom.*proxy'` fallback SIGTERM'd the HEALTHY proxy —
    // the "we were killing it ourselves" bug, re-entered through a new door.
    const spawnProxyForce = vi.fn();
    const adoptRunningProxy = vi.fn(() => 4242);
    const result = await ensureHeadroomProxy(deps({ adoptRunningProxy, spawnProxyForce }));

    expect(result).toBe('starting');
    expect(adoptRunningProxy).toHaveBeenCalled();
    expect(spawnProxyForce).not.toHaveBeenCalled(); // ← the healthy proxy survives
  });

  it('still respawns when there is genuinely nothing to adopt', async () => {
    const spawnProxyForce = vi.fn();
    const result = await ensureHeadroomProxy(
      deps({ adoptRunningProxy: () => null, spawnProxyForce }),
    );
    expect(result).toBe('respawned');
    expect(spawnProxyForce).toHaveBeenCalled();
  });

  it('never adopts while the proxy answers /livez (no needless pidfile churn)', async () => {
    const adoptRunningProxy = vi.fn(() => 1);
    const result = await ensureHeadroomProxy(deps({ probeAlive: async () => true, adoptRunningProxy }));
    expect(result).toBe('alive');
    expect(adoptRunningProxy).not.toHaveBeenCalled();
  });
});
