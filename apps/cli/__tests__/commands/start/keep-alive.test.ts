import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Regression: `buildKeepAlive` exists and PATCHes
 * `idle_timeout_minutes=240` via `gh api`, but `start.ts` only
 * invoked it when the mobile/web Settings toggle fired. Fresh
 * codespaces inherited GitHub's 30-min default, the in-codespace
 * `codeam` died on the first long pause, and the dashboard's
 * next `list_files` / `terminal_open` command stranded against
 * a session whose plugin was gone — surfacing as a generic
 * "No files found" / "Could not open terminal" on the user's
 * next visit.
 *
 * `start.ts` now auto-applies keep-alive when `inCodespace` so
 * codespaces stay alive 4 h regardless of whether the user ever
 * touched the Settings toggle. These specs pin:
 *
 *   1. `apply(true)` inside a codespace spawns `gh api PATCH
 *      /user/codespaces/<name> -F idle_timeout_minutes=240`.
 *   2. `apply(false)` resets to 30 — Settings can opt out.
 *   3. `apply(true)` outside a codespace is a no-op.
 *   4. A 30-min re-apply timer absorbs transient `gh` failures.
 */

import { buildKeepAlive } from '../../../src/commands/start/keep-alive';

const spawnCalls: Array<{ cmd: string; args: string[] }> = [];

vi.mock('child_process', () => ({
  spawn: vi.fn((cmd: string, args: string[]) => {
    spawnCalls.push({ cmd, args });
    return {
      unref: () => {},
      on: (event: string, cb: () => void) => {
        if (event === 'exit') queueMicrotask(cb);
      },
    };
  }),
}));

beforeEach(() => {
  spawnCalls.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildKeepAlive — default-on inside codespace', () => {
  it('apply(true) inside a codespace PATCHes idle_timeout_minutes=240 via gh', async () => {
    const { apply } = buildKeepAlive({
      inCodespace: true,
      codespaceName: 'codeagent-mobile-x496',
    });
    apply(true);
    await vi.advanceTimersByTimeAsync(0);

    const call = spawnCalls[0];
    expect(call).toBeDefined();
    expect(call?.cmd).toBe('gh');
    expect(call?.args).toContain('PATCH');
    expect(call?.args).toContain('/user/codespaces/codeagent-mobile-x496');
    expect(call?.args).toContain('idle_timeout_minutes=240');
  });

  it('apply(false) resets idle_timeout_minutes to 30 — Settings can opt out', async () => {
    const { apply } = buildKeepAlive({
      inCodespace: true,
      codespaceName: 'cs-1',
    });
    apply(false);
    await vi.advanceTimersByTimeAsync(0);

    expect(spawnCalls[0]?.args).toContain('idle_timeout_minutes=30');
  });

  it('apply(true) outside a codespace is a no-op (no gh spawn)', async () => {
    const { apply } = buildKeepAlive({
      inCodespace: false,
      codespaceName: undefined,
    });
    apply(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(spawnCalls.length).toBe(0);
  });

  it('re-applies every 30 min so a transient gh failure self-heals on the next tick', async () => {
    const { apply } = buildKeepAlive({
      inCodespace: true,
      codespaceName: 'cs-1',
    });
    apply(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(spawnCalls.length).toBe(1);

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(spawnCalls.length).toBe(2);

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(spawnCalls.length).toBe(3);
  });
});
