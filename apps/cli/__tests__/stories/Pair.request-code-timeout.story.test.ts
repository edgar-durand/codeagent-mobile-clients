/**
 * Story — Pair: requestCode times out gracefully on a slow / dead backend.
 *
 * Why this test exists
 * --------------------
 * QA report #5 (Android, 2026-06-06): `codeam pair` printed "Requesting
 * pairing code..." and never moved for 10 minutes. No error, no QR, no
 * exit code. The user gave up and killed the process by hand.
 *
 * The CLI's `requestCode` (apps/cli/src/services/pairing.service.ts)
 * POSTs to `/api/pairing/code` with no client-side timeout. If the backend
 * accepts the TCP connection but never sends a response body (slow
 * Vercel cold-start, Cloud Run scale-from-zero stall, transparent
 * proxy holding the socket open), the CLI hangs indefinitely.
 *
 * Expected behaviour
 * ------------------
 * `requestCode` aborts after a bounded budget (~10 s) and returns `null`
 * so the caller (`pair.ts`) prints the existing "Could not reach the
 * server" error and exits with code 1. The user sees an actionable
 * failure within seconds, not after 10 minutes.
 *
 * What this test DOESN'T do
 * -------------------------
 * - Doesn't hit a real backend (lives next to the unit suite, not under
 *   `integration/`).
 * - Doesn't assert spinner UI text — clack/prompts is mocked at a higher
 *   layer; this test owns the request-side contract.
 * - Doesn't assert on the per-call timeout *value* — we treat anything
 *   under 30 s as "bounded enough" so a future tightening from 10 s →
 *   5 s doesn't churn the test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requestCode, _transport } from '../../src/services/pairing.service';

const PLUGIN_ID = 'cmq2de1ep003ocs9urlgjtybp';

describe('story: pair / requestCode times out on a hung backend', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('resolves to null within a bounded budget when the POST never returns', async () => {
    // ── Story setup ─────────────────────────────────────────────────
    // Edgar's laptop is on a wifi behind a proxy that ACKs the TCP
    // SYN but never forwards the body — the worst possible case for a
    // naive fetch. Model that by giving `postJson` a promise that
    // resolves only after the test would have given up.
    const NEVER_RESOLVES = new Promise<never>(() => {
      /* deliberately never settles */
    });
    const postSpy = vi.spyOn(_transport, 'postJson').mockReturnValue(NEVER_RESOLVES);

    // ── Action ─────────────────────────────────────────────────────
    // Edgar runs `codeam pair`. `requestCode` is the first thing the
    // command does — we call it directly so we don't have to drive the
    // whole pair() CLI loop here.
    const promise = requestCode(PLUGIN_ID);

    // Burn enough fake time that any reasonable implementation MUST
    // have given up. The current `pairing.service.ts` has no timeout
    // at all → it'll still be waiting on the promise → this assertion
    // fails until we wrap the call with an abort signal.
    await vi.advanceTimersByTimeAsync(30_000);

    // ── Observable outcome ─────────────────────────────────────────
    // The contract is: `requestCode` returns a discriminated union;
    // a hung connection lands on `{ ok: false, reason: 'timeout' }`
    // so the caller can render a specific message instead of a
    // generic "could not reach the server".
    await expect(
      Promise.race([promise, Promise.resolve('still-waiting' as const)]),
    ).resolves.toEqual({ ok: false, reason: 'timeout' });

    // We did try the request — proves the timeout isn't a no-op shortcut.
    expect(postSpy).toHaveBeenCalledTimes(1);
  });
});
