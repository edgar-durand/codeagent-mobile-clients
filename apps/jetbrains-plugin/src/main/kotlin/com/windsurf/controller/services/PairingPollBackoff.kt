package com.windsurf.controller.services

/**
 * Poll pacing for the pairing-status loop.
 *
 * Extracted as a pure function so the pacing policy is unit-testable without an
 * IntelliJ platform harness (same approach as `buildAgentsPayload`).
 *
 * Why this exists (2026-08-12): the loop used to poll `/api/pairing/status`
 * every 3 s for the whole 5-minute window and only looked at
 * `response.isSuccessful`, so a 429 was indistinguishable from "not paired
 * yet". Measured on prod, ONE plugin instance in that state produced 88% of ALL
 * backend requests (1.67M/day at ~25 DAU), 94% of them 429s — it burned the
 * Cloud Logging quota and, because the status poll itself was throttled, could
 * keep pairing from ever completing.
 */

/** Normal cadence while waiting for the user to enter the code. */
const val BASE_POLL_DELAY_MS = 3_000L

/**
 * Ceiling for any single wait. Also the clamp for a server-supplied
 * `Retry-After`: the header is a hint from an untrusted-to-us source, and an
 * absurd value (or a stray `Retry-After: 86400`) would silently park pairing
 * for the rest of the session.
 */
const val MAX_POLL_DELAY_MS = 30_000L

/**
 * How long to wait before the next status poll.
 *
 * @param status HTTP status of the poll that just completed (use 0 for a
 *   transport error — treated as a throttle-worthy failure).
 * @param retryAfterSeconds parsed `Retry-After` response header, when present.
 * @param consecutiveThrottles how many throttled/failed polls have happened
 *   back-to-back; reset to 0 on any successful poll.
 */
fun nextPollDelayMs(status: Int, retryAfterSeconds: Int?, consecutiveThrottles: Int): Long {
    val throttled = status == 429 || status >= 500 || status == 0
    if (!throttled) return BASE_POLL_DELAY_MS

    // The server told us how long to wait — honour it, but never beyond the cap.
    if (retryAfterSeconds != null && retryAfterSeconds > 0) {
        return minOf(retryAfterSeconds.toLong() * 1_000L, MAX_POLL_DELAY_MS)
    }

    // No hint: exponential backoff from the base cadence, capped.
    val exponent = (consecutiveThrottles - 1).coerceAtLeast(0).coerceAtMost(10)
    val backoff = BASE_POLL_DELAY_MS * (1L shl exponent) * 2
    return minOf(backoff, MAX_POLL_DELAY_MS)
}
