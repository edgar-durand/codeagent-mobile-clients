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

  // ── Two-tier escalation (2026-07-14 compaction-brick incident) ─────
  //
  // Claude's context auto-compaction emits ONE "Compacting..." chunk and
  // then runs SILENTLY for minutes (a single giant summarization call —
  // no tool calls, no updates). The flat 90s idle window killed it every
  // time; the abort left compaction pending, so EVERY subsequent turn
  // re-triggered it and died the same way — a permanently bricked
  // session. The strict window exists to catch auth/network hangs, which
  // are silent FROM THE FIRST BYTE — so once ANY bump has proven the
  // adapter alive, the window escalates to `activeIdleMs`.

  it('escalates the idle window to activeIdleMs after the first bump (compaction survives)', async () => {
    const ACTIVE = 600_000;
    const idle = createIdleTimeout(IDLE, makeError, ACTIVE);
    const t = track(idle.promise);

    // Proof of life: the "Compacting..." message chunk bumps once…
    await vi.advanceTimersByTimeAsync(10_000);
    idle.bump();

    // …then compaction runs silently PAST the strict window — must NOT fire.
    await vi.advanceTimersByTimeAsync(IDLE * 3);
    expect(t.rejected()).toBe(false);

    // A genuinely wedged mid-turn adapter still surfaces at the active window.
    await vi.advanceTimersByTimeAsync(ACTIVE - IDLE * 3);
    expect(t.rejected()).toBe(true);
  });

  it('without activeIdleMs the flat window is unchanged (default opt-out)', async () => {
    const idle = createIdleTimeout(IDLE, makeError);
    const t = track(idle.promise);
    idle.bump();
    await vi.advanceTimersByTimeAsync(IDLE + 1);
    expect(t.rejected()).toBe(true);
  });

  it('escalation survives suspend/re-arm cycles (permission wait during an active turn)', async () => {
    const ACTIVE = 600_000;
    const idle = createIdleTimeout(IDLE, makeError, ACTIVE);
    const t = track(idle.promise);

    idle.bump(); // turn is alive
    idle.suspend(); // human decision
    await vi.advanceTimersByTimeAsync(IDLE * 10);
    expect(t.rejected()).toBe(false);
    idle.bump(); // answered — re-arm at the ACTIVE window, not the strict one
    await vi.advanceTimersByTimeAsync(IDLE * 2);
    expect(t.rejected()).toBe(false);
    await vi.advanceTimersByTimeAsync(ACTIVE);
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
