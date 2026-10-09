package com.windsurf.controller.services

import com.google.gson.JsonParser

/**
 * Port of the CLI 2.75.8 heartbeat contract (`apps/cli/src/services/
 * command-relay.service.ts` `sendHeartbeat` / `noteHeartbeatFailure` /
 * `handleSessionGone`), kept free of IntelliJ services so it is unit-testable.
 *
 * Why it exists (codeagent-8x0e, 2026-09-23): a user's heartbeats never
 * reached the origin. The `plugin::status` key (TTL 50 s) expired and the app
 * showed the session OFFLINE while the IDE was running. The plugin logged
 * the miss at DEBUG, which idea.log drops by default, and never retried, so
 * two missed beats in a row were enough to go offline. It also ignored the
 * response body, so a session the user deleted from the app kept heartbeating
 * through its open SSE.
 */
internal const val HEARTBEAT_RETRY_MS = 3_000L
internal const val HEARTBEAT_WARN_INTERVAL_MS = 60_000L

/** What the relay does after one heartbeat attempt. */
internal data class HeartbeatAction(
    /** Backend says this pluginId no longer has a live session: stop and forget the pairing. */
    val sessionGone: Boolean = false,
    /** Non-null: log at WARN and send `heartbeat_failed` with this reason + [streak]. */
    val warnReason: String? = null,
    val streak: Int = 0,
    /** Non-null: send one more heartbeat after this delay. */
    val retryInMs: Long? = null,
)

/**
 * `data.paired` from a heartbeat response body. `null` when the field is absent
 * (backends older than 2026-09-23, or a pluginId the backend can't resolve, which
 * means "unknown", not "gone") or the body is not JSON.
 */
internal fun parseHeartbeatPaired(body: String?): Boolean? {
    if (body.isNullOrBlank()) return null
    return runCatching {
        val data = JsonParser.parseString(body).asJsonObject.getAsJsonObject("data") ?: return null
        val paired = data.get("paired") ?: return null
        if (paired.isJsonPrimitive && paired.asJsonPrimitive.isBoolean) paired.asBoolean else null
    }.getOrNull()
}

/** Short reason for a failed beat: `status_<code>` for an HTTP error, else the exception class/message. */
internal fun heartbeatFailureReason(status: Int?, error: Throwable?): String = when {
    status != null -> "status_$status"
    error != null -> (error::class.simpleName ?: error.message ?: "error").take(80)
    else -> "unknown"
}

/**
 * Failure streak + WARN rate limit + retry decision for the ONLINE heartbeat.
 * The first failure of a streak always warns; later ones warn at most once per
 * [warnIntervalMs]. Only the timer's own beat (attempt 0) schedules a retry, so a
 * failing retry never chains into another one.
 */
internal class HeartbeatMonitor(
    private val warnIntervalMs: Long = HEARTBEAT_WARN_INTERVAL_MS,
    private val retryMs: Long = HEARTBEAT_RETRY_MS,
) {
    private var streak = 0
    private var lastWarnAt = 0L

    @Synchronized
    fun onSuccess(responseBody: String?): HeartbeatAction {
        streak = 0
        return HeartbeatAction(sessionGone = parseHeartbeatPaired(responseBody) == false)
    }

    @Synchronized
    fun onFailure(reason: String, attempt: Int, running: Boolean, nowMs: Long): HeartbeatAction {
        streak += 1
        val warn = streak == 1 || nowMs - lastWarnAt >= warnIntervalMs
        if (warn) lastWarnAt = nowMs
        return HeartbeatAction(
            warnReason = if (warn) reason else null,
            streak = streak,
            retryInMs = if (attempt == 0 && running) retryMs else null,
        )
    }
}
