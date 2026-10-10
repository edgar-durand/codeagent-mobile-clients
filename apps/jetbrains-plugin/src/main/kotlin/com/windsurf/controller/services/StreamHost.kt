package com.windsurf.controller.services

import com.windsurf.controller.DEFAULT_API_BASE_URL
import com.windsurf.controller.DEV_API_BASE_URL

/**
 * Stream-tier base URL for the command relay's SSE subscription. Kotlin port of
 * the CLI's `apps/cli/src/services/stream-base-url.ts` (the plugin does not
 * consume `@codeam/shared`).
 *
 * The backend serves the long-lived SSE routes from `stream.` and everything
 * else from `api.`; paths never change, only the base. Once prod's api tier
 * runs `SERVICE_ROLE=api` it answers 404 on `/api/commands/pending/stream`, so
 * a plugin opening the stream on `apiBaseUrl` would drop to polling for good
 * (bead codeagent-8x0e.9).
 *
 * One-time fallback: a network error or a 5xx on the stream host BEFORE any
 * byte arrived latches the relay onto the api base until `apiBaseUrl` changes.
 * 4xx never triggers it (an `api`-role 404 must stay visible) and a stream
 * that delivered then dropped is a normal reconnect.
 */
const val DEFAULT_STREAM_BASE_URL: String = "https://stream.codeagent-mobile.com"
const val DEV_STREAM_BASE_URL: String = "https://dev-stream.codeagent-mobile.com"

private val STREAM_HOST_FOR_API_HOST = mapOf(
    DEFAULT_API_BASE_URL to DEFAULT_STREAM_BASE_URL,
    DEV_API_BASE_URL to DEV_STREAM_BASE_URL,
)

fun resolveStreamBaseUrl(apiBase: String): String {
    val base = apiBase.trimEnd('/')
    return STREAM_HOST_FOR_API_HOST[base] ?: base
}

/** `status == null` means a network error (no HTTP status at all). */
fun shouldFallBackToApiHost(status: Int?, delivered: Boolean): Boolean {
    if (delivered) return false
    if (status == null) return true
    return status >= 500
}

class StreamHostSelector {
    private var apiBase: String? = null
    private var fellBackToApi = false

    @Synchronized
    fun currentFor(apiBase: String): String {
        val base = apiBase.trimEnd('/')
        if (base != this.apiBase) {
            this.apiBase = base
            fellBackToApi = false
        }
        return if (fellBackToApi) base else resolveStreamBaseUrl(base)
    }

    /** True exactly once: on the failure that moves the relay onto the api base. */
    @Synchronized
    fun fallBackToApiHost(apiBase: String, status: Int?, delivered: Boolean): Boolean {
        val base = apiBase.trimEnd('/')
        if (currentFor(base) == base) return false
        if (!shouldFallBackToApiHost(status, delivered)) return false
        fellBackToApi = true
        return true
    }
}
