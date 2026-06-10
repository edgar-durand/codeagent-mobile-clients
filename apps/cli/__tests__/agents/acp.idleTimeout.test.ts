/**
 * Tests for the ACP prompt idle watchdog.
 *
 * The watchdog must reject ONLY on genuine adapter silence, never on
 * a long-but-active turn. These cases pin the exact regression that
 * stranded mobile turns: an agent emitting an update every few seconds
 * for far longer than the idle window must run to completion, while a
 * truly silent adapter still fails fast.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdleTimeout } from '../../src/agents/acp/idleTimeout';

const IDLE = 90_000;
const makeError = () => new Error('idle');

/** Attach a catch so an expected rejection never registers as an
 *  unhandled rejection, and report settlement synchronously. */
function track(promise: Promise<never>): { rejected: () => boolean } {
  let rejected = false;
  promise.then(
    () => {},
    () => {
      rejected = true;
    },
  );
  return { rejected: () => rejected };
}

describe('createIdleTimeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('rejects after the idle window when never bumped (wedged adapter)', async () => {
    const idle = createIdleTimeout(IDLE, makeError);
    const t = track(idle.promise);

    await vi.advanceTimersByTimeAsync(IDLE - 1);
    expect(t.rejected()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(t.rejected()).toBe(true);
    await expect(idle.promise).rejects.toThrow('idle');
  });

  it('never fires while bumped within the window (long active turn)', async () => {
    const idle = createIdleTimeout(IDLE, makeError);
    const t = track(idle.promise);

    // 30 bumps spaced 80 s apart = 2400 s of wall-clock — ~27× a
    // total-elapsed cap would have allowed, yet never idle for 90 s.
    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(80_000);
      idle.bump();
    }
    expect(t.rejected()).toBe(false);

    // Then go silent → fires one idle window later.
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(t.rejected()).toBe(true);
  });

  it('does not fire while suspended, even past the idle window (human wait)', async () => {
    const idle = createIdleTimeout(IDLE, makeError);
    const t = track(idle.promise);

    idle.suspend();
    await vi.advanceTimersByTimeAsync(IDLE * 5);
    expect(t.rejected()).toBe(false);

    // Re-arm on the human's answer → countdown restarts fresh.
    idle.bump();
    await vi.advanceTimersByTimeAsync(IDLE - 1);
    expect(t.rejected()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.rejected()).toBe(true);
  });

  it('clear() permanently disarms — late bumps and timers are no-ops', async () => {
    const idle = createIdleTimeout(IDLE, makeError);
    const t = track(idle.promise);

    idle.clear();
    idle.bump(); // late activity after the prompt settled
    await vi.advanceTimersByTimeAsync(IDLE * 3);
    expect(t.rejected()).toBe(false);
  });
});
