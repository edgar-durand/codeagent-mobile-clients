package com.windsurf.controller.services

import org.junit.Test
import java.io.IOException
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Regression (codeagent-8x0e.8): the JetBrains heartbeat swallowed every failure at
 * DEBUG, never retried and ignored the response body, so two lost beats took the
 * session OFFLINE with nothing in idea.log, and a session deleted from the app kept
 * heartbeating. These pin the CLI 2.75.8 contract the plugin now follows.
 */
class HeartbeatPolicyTest {
    @Test
    fun `paired false in the response is a session-gone verdict`() {
        val action = HeartbeatMonitor().onSuccess("""{"success":true,"data":{"pluginId":"p","online":true,"paired":false}}""")
        assertTrue(action.sessionGone)
        assertNull(action.retryInMs)
        assertNull(action.warnReason)
    }

    @Test
    fun `paired true or an absent field never ends the session`() {
        val monitor = HeartbeatMonitor()
        assertFalse(monitor.onSuccess("""{"success":true,"data":{"pluginId":"p","online":true,"paired":true}}""").sessionGone)
        // Older backend / unresolvable pluginId: "unknown", never "gone".
        assertFalse(monitor.onSuccess("""{"success":true,"data":{"pluginId":"p","online":true}}""").sessionGone)
        assertFalse(monitor.onSuccess("").sessionGone)
        assertFalse(monitor.onSuccess("not json").sessionGone)
        assertFalse(monitor.onSuccess("""{"data":{"paired":"false"}}""").sessionGone)
    }

    @Test
    fun `first failure warns and schedules one retry after 3 s`() {
        val action = HeartbeatMonitor().onFailure("status_502", attempt = 0, running = true, nowMs = 1_000L)
        assertEquals("status_502", action.warnReason)
        assertEquals(1, action.streak)
        assertEquals(HEARTBEAT_RETRY_MS, action.retryInMs)
        assertEquals(3_000L, HEARTBEAT_RETRY_MS)
    }

    @Test
    fun `a failing retry does not chain another retry`() {
        val monitor = HeartbeatMonitor()
        monitor.onFailure("IOException", attempt = 0, running = true, nowMs = 0L)
        val retry = monitor.onFailure("IOException", attempt = 1, running = true, nowMs = 3_000L)
        assertNull(retry.retryInMs)
        assertEquals(2, retry.streak)
    }

    @Test
    fun `no retry once the relay stopped`() {
        assertNull(HeartbeatMonitor().onFailure("IOException", attempt = 0, running = false, nowMs = 0L).retryInMs)
    }

    @Test
    fun `warnings inside a streak are rate limited to one per minute`() {
        val monitor = HeartbeatMonitor()
        assertEquals("x", monitor.onFailure("x", 0, true, nowMs = 0L).warnReason)
        assertNull(monitor.onFailure("x", 1, true, nowMs = 3_000L).warnReason)
        assertNull(monitor.onFailure("x", 0, true, nowMs = 30_000L).warnReason)
        val later = monitor.onFailure("x", 0, true, nowMs = HEARTBEAT_WARN_INTERVAL_MS)
        assertEquals("x", later.warnReason)
        assertEquals(4, later.streak)
    }

    @Test
    fun `a success resets the streak so the next failure warns again`() {
        val monitor = HeartbeatMonitor()
        monitor.onFailure("x", 0, true, nowMs = 0L)
        monitor.onSuccess("""{"data":{"paired":true}}""")
        val next = monitor.onFailure("y", 0, true, nowMs = 1_000L)
        assertEquals(1, next.streak)
        assertEquals("y", next.warnReason)
    }

    @Test
    fun `failure reason is status code or exception class`() {
        assertEquals("status_401", heartbeatFailureReason(401, null))
        assertEquals("IOException", heartbeatFailureReason(null, IOException("reset")))
        assertEquals("unknown", heartbeatFailureReason(null, null))
    }
}
