package com.windsurf.controller.services

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Regression (2026-08-12): the pairing-status poller ignored rate limiting.
 *
 * `startPollingForPairing` used `scheduleAtFixedRate(2000, 3000)` and only ever
 * inspected `response.isSuccessful`, so a 429 was indistinguishable from "not
 * paired yet" and the plugin kept hammering `/api/pairing/status` every 3 s for
 * the full 5-minute window. Measured on prod that day: ONE plugin instance was
 * generating 88% of ALL backend requests (1.67M/day at ~25 DAU) and 94% of them
 * came back 429 — it burned the Cloud Logging quota AND, because the status
 * poll itself was being throttled, plausibly prevented pairing from ever
 * completing for JetBrains users.
 *
 * Fixed-rate scheduling made it worse: the HTTP call is synchronous inside the
 * TimerTask, so any response slower than the period made Timer fire catch-up
 * executions back-to-back.
 */
class PairingPollBackoffTest {
    @Test
    fun `not-yet-paired keeps the base cadence`() {
        assertEquals(3_000L, nextPollDelayMs(status = 200, retryAfterSeconds = null, consecutiveThrottles = 0))
    }

    @Test
    fun `429 honours the server's Retry-After`() {
        assertEquals(
            5_000L,
            nextPollDelayMs(status = 429, retryAfterSeconds = 5, consecutiveThrottles = 1),
        )
    }

    @Test
    fun `429 without Retry-After backs off exponentially instead of hammering`() {
        val first = nextPollDelayMs(status = 429, retryAfterSeconds = null, consecutiveThrottles = 1)
        val second = nextPollDelayMs(status = 429, retryAfterSeconds = null, consecutiveThrottles = 2)
        val third = nextPollDelayMs(status = 429, retryAfterSeconds = null, consecutiveThrottles = 3)
        assertTrue(first > 3_000L, "a throttled poll must wait longer than the base cadence")
        assertTrue(second > first && third > second, "backoff must grow: $first -> $second -> $third")
    }

    @Test
    fun `backoff is capped so pairing still completes within the window`() {
        val huge = nextPollDelayMs(status = 429, retryAfterSeconds = null, consecutiveThrottles = 99)
        assertTrue(huge <= MAX_POLL_DELAY_MS, "delay $huge exceeded the cap $MAX_POLL_DELAY_MS")
    }

    @Test
    fun `an absurd Retry-After is clamped to the cap, never trusted verbatim`() {
        assertEquals(
            MAX_POLL_DELAY_MS,
            nextPollDelayMs(status = 429, retryAfterSeconds = 86_400, consecutiveThrottles = 1),
        )
    }

    @Test
    fun `server errors back off too, rather than retrying at full speed`() {
        assertTrue(
            nextPollDelayMs(status = 503, retryAfterSeconds = null, consecutiveThrottles = 1) > 3_000L,
        )
    }

    @Test
    fun `recovering from throttling returns to the base cadence`() {
        assertEquals(3_000L, nextPollDelayMs(status = 200, retryAfterSeconds = null, consecutiveThrottles = 0))
    }
}
