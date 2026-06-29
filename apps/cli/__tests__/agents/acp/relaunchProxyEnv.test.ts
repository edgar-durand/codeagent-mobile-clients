/**
 * Fix I-A: "Pause budget this session" silently no-ops — regression test.
 *
 * Root cause (2026-06-28):
 *   `relaunchProxyWithoutBudget` in runner.ts spread `process.env` into
 *   `proxyEnv` but did NOT delete `HEADROOM_BUDGET` / `HEADROOM_BUDGET_PERIOD`.
 *   The `headroom_budget` handler writes those keys into `process.env` on the
 *   same process, so the "paused" proxy inherited the budget cap from env and
 *   came back capped → the next prompt 429'd again.
 *
 * Fix:
 *   Introduced `buildRelaunchProxyEnv(baseEnv)` — a pure exported helper that
 *   spreads the base env, forces `HEADROOM_KOMPRESS_BACKEND=onnx_cpu`, then
 *   **deletes** both budget keys. `relaunchProxyWithoutBudget` now calls it
 *   instead of building the env object inline.
 *
 * This test asserts the invariant at the pure-function boundary so the fix
 * is verified without spawning a process or importing the full runner graph.
 */

import { describe, it, expect } from 'vitest';
import { buildRelaunchProxyEnv } from '../../../src/agents/acp/runner';

describe('buildRelaunchProxyEnv — pause clears budget env', () => {
  it('strips HEADROOM_BUDGET when it was set in the base env', () => {
    const base: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HEADROOM_BUDGET: '10',
      HEADROOM_BUDGET_PERIOD: 'daily',
    };
    const result = buildRelaunchProxyEnv(base);
    expect(result['HEADROOM_BUDGET']).toBeUndefined();
  });

  it('strips HEADROOM_BUDGET_PERIOD when it was set in the base env', () => {
    const base: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HEADROOM_BUDGET: '5',
      HEADROOM_BUDGET_PERIOD: 'monthly',
    };
    const result = buildRelaunchProxyEnv(base);
    expect(result['HEADROOM_BUDGET_PERIOD']).toBeUndefined();
  });

  it('strips both budget keys regardless of the period value (hourly/daily/monthly)', () => {
    for (const period of ['hourly', 'daily', 'monthly']) {
      const result = buildRelaunchProxyEnv({
        HEADROOM_BUDGET: '20',
        HEADROOM_BUDGET_PERIOD: period,
      });
      expect(result['HEADROOM_BUDGET']).toBeUndefined();
      expect(result['HEADROOM_BUDGET_PERIOD']).toBeUndefined();
    }
  });

  it('preserves unrelated env keys', () => {
    const base: NodeJS.ProcessEnv = {
      PATH: '/usr/local/bin',
      HOME: '/root',
      HEADROOM_BUDGET: '3',
      HEADROOM_BUDGET_PERIOD: 'daily',
    };
    const result = buildRelaunchProxyEnv(base);
    expect(result['PATH']).toBe('/usr/local/bin');
    expect(result['HOME']).toBe('/root');
  });

  it('sets HEADROOM_KOMPRESS_BACKEND=onnx_cpu unconditionally', () => {
    const result = buildRelaunchProxyEnv({
      HEADROOM_BUDGET: '7',
      HEADROOM_BUDGET_PERIOD: 'daily',
    });
    expect(result['HEADROOM_KOMPRESS_BACKEND']).toBe('onnx_cpu');
  });

  it('works correctly even when budget keys are absent from the base env', () => {
    const result = buildRelaunchProxyEnv({ PATH: '/usr/bin' });
    expect(result['HEADROOM_BUDGET']).toBeUndefined();
    expect(result['HEADROOM_BUDGET_PERIOD']).toBeUndefined();
    expect(result['HEADROOM_KOMPRESS_BACKEND']).toBe('onnx_cpu');
  });

  it('does not mutate the original base env object', () => {
    const base: NodeJS.ProcessEnv = {
      HEADROOM_BUDGET: '15',
      HEADROOM_BUDGET_PERIOD: 'daily',
    };
    buildRelaunchProxyEnv(base);
    // The original must be untouched.
    expect(base['HEADROOM_BUDGET']).toBe('15');
    expect(base['HEADROOM_BUDGET_PERIOD']).toBe('daily');
  });

  it('mirrors process.env: strips budget keys even when process.env has them (the real scenario)', () => {
    // Simulate the headroom_budget handler writing budget keys into process.env
    // before relaunchProxyWithoutBudget is called.
    const fakeProcessEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HEADROOM_BUDGET: '50',
      HEADROOM_BUDGET_PERIOD: 'daily',
    };
    const result = buildRelaunchProxyEnv(fakeProcessEnv);
    // The "paused" proxy spawn env must have NO budget cap.
    expect(result['HEADROOM_BUDGET']).toBeUndefined();
    expect(result['HEADROOM_BUDGET_PERIOD']).toBeUndefined();
    expect(result['HEADROOM_KOMPRESS_BACKEND']).toBe('onnx_cpu');
  });
});
