/**
 * Idle (inactivity) watchdog for a single ACP `session/prompt`
 * round-trip.
 *
 * Why idle, not total-elapsed: a real agentic turn legitimately runs
 * for minutes — it interleaves reasoning, many tool calls, and
 * human-in-the-loop permission approvals. A fixed total-elapsed cap
 * false-trips on a perfectly healthy turn the moment its wall-clock
 * crosses the ceiling (observed: a `bd`-audit turn emitted a
 * `session/update` every few seconds for 90 s straight, gated by five
 * `select_option` approvals, then got killed at exactly 90.001 s — the
 * mobile client never received the final answer).
 *
 * The watchdog only fires when the adapter goes genuinely silent —
 * no `session/update` and no in-flight permission request — for the
 * full idle window. That is the actual "adapter never responded"
 * failure the timeout exists to catch (a wedged/auth-broken adapter),
 * with no false positives on long-but-active work.
 *
 * Lifecycle from the prompt caller:
 *   - `bump()`   on every `session/update` notification (proof of life)
 *   - `suspend()` while awaiting a human permission decision (no
 *     updates flow during that wait, and the human may take minutes)
 *   - `bump()`   again once the human answers (re-arm fresh)
 *   - `clear()`  in the prompt's `finally` (permanently disarm)
 */
export interface IdleTimeout {
  /** Rejects with `makeError()` when no `bump()` occurs for the idle
   *  window while armed. Never resolves — race it against the real
   *  work promise. */
  readonly promise: Promise<never>;
  /** Restart the idle countdown. Call on any adapter activity. No-op
   *  after `clear()`. */
  bump(): void;
  /** Stop the countdown without re-arming. Call while blocked on a
   *  human decision; re-arm with `bump()` once it resolves. */
  suspend(): void;
  /** Permanently disarm. Call once the prompt settles so a late
   *  timer can't reject after we've moved on. */
  clear(): void;
}

export function createIdleTimeout(
  idleMs: number,
  makeError: () => Error,
): IdleTimeout {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  let reject!: (err: Error) => void;

  const promise = new Promise<never>((_resolve, rej) => {
    reject = rej;
  });

  const stop = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const arm = (): void => {
    if (done) return;
    timer = setTimeout(() => {
      done = true;
      reject(makeError());
    }, idleMs);
    // Don't let the watchdog alone keep the event loop alive.
    timer.unref?.();
  };

  // Arm immediately: a prompt that never produces a single update is
  // exactly the wedged-adapter case we must still catch.
  arm();

  return {
    promise,
    bump: (): void => {
      if (done) return;
      stop();
      arm();
    },
    suspend: (): void => {
      stop();
    },
    clear: (): void => {
      done = true;
      stop();
    },
  };
}
