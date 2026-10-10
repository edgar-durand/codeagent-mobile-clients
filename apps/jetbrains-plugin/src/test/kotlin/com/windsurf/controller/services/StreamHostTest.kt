package com.windsurf.controller.services

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Regression (codeagent-8x0e.9): the relay opened /api/commands/pending/stream on
 * apiBaseUrl. With prod's api tier on SERVICE_ROLE=api that route is a 404 and the
 * plugin would fall to polling for good. The stream must open on the stream host.
 */
class StreamHostTest {
    private val api = "https://api.codeagent-mobile.com"

    @Test
    fun `prod and dev api hosts map to their stream hosts`() {
        assertEquals(DEFAULT_STREAM_BASE_URL, resolveStreamBaseUrl(api))
        assertEquals(DEFAULT_STREAM_BASE_URL, resolveStreamBaseUrl("$api/"))
        assertEquals(DEV_STREAM_BASE_URL, resolveStreamBaseUrl("https://dev-api.codeagent-mobile.com"))
        assertEquals("http://localhost:3001", resolveStreamBaseUrl("http://localhost:3001/"))
    }

    @Test
    fun `selector starts on the stream host and latches onto the api host once on a 5xx`() {
        val s = StreamHostSelector()
        assertEquals(DEFAULT_STREAM_BASE_URL, s.currentFor(api))
        assertTrue(s.fallBackToApiHost(api, 525, delivered = false))
        assertEquals(api, s.currentFor(api))
        assertFalse(s.fallBackToApiHost(api, null, delivered = false))
    }

    @Test
    fun `4xx and post-delivery failures never fall back`() {
        val s = StreamHostSelector()
        assertFalse(s.fallBackToApiHost(api, 404, delivered = false))
        assertFalse(s.fallBackToApiHost(api, 401, delivered = false))
        assertFalse(s.fallBackToApiHost(api, null, delivered = true))
        assertEquals(DEFAULT_STREAM_BASE_URL, s.currentFor(api))
    }

    @Test
    fun `a network error before delivery falls back, and a new api base re-derives`() {
        val s = StreamHostSelector()
        assertTrue(s.fallBackToApiHost(api, null, delivered = false))
        assertEquals(DEV_STREAM_BASE_URL, s.currentFor("https://dev-api.codeagent-mobile.com"))
    }
}
