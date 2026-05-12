package com.windsurf.controller.services

import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.Timer
import java.util.TimerTask
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.min

fun Request.Builder.withAuthHeaders(): Request.Builder {
    addHeader("X-Codeam-Protocol-Version", "2.0.0")
    SettingsService.getInstance().getPluginAuthToken()?.let { addHeader("X-Plugin-Auth-Token", it) }
    return this
}

/**
 * Bidirectional command relay. The modern path is an SSE pull stream that
 * the backend pushes commands down — backend wakes the plugin within ~50 ms
 * of `pushCommand` instead of waiting on a 0-2 s polling tick. Vercel's
 * 25 s function-invocation cap closes the stream periodically; we
 * immediately reconnect (long-poll style).
 *
 * If the SSE endpoint is unreachable for any reason (network hiccup,
 * older backend without `/pending/stream`, proxy that strips SSE) the
 * relay falls back to plain HTTP polling. Both modes share the same
 * `dispatch` path so listeners see commands identically.
 */
@Service(Service.Level.APP)
class CommandRelayService {

    private val logger = Logger.getInstance(CommandRelayService::class.java)
    private val gson = Gson()

    /** Short-timeout client for polling + one-shot requests. */
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    /** Long-lived client for SSE — no read timeout, Vercel closes for us. */
    private val sseClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)
        .build()

    private val scheduler: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "command-relay-scheduler").apply { isDaemon = true }
        }

    private val listeners = CopyOnWriteArrayList<CommandListener>()

    @Volatile
    private var isRunning: Boolean = false

    /** Public flag kept for backward compatibility with existing callers. */
    val isPolling: Boolean
        get() = isRunning

    private var heartbeatTimer: Timer? = null
    private var agentsTimer: Timer? = null

    /** True once `/api/plugin/agents` has accepted at least one report. */
    @Volatile
    private var agentsRegistered = false

    // ─── SSE state ───────────────────────────────────────────────────
    private var sseThread: Thread? = null
    private var sseCall: Call? = null
    private var sseReconnectTask: ScheduledFuture<*>? = null
    private var sseFailures: Int = 0

    // ─── Polling fallback state ──────────────────────────────────────
    private var pollTask: ScheduledFuture<*>? = null
    private var pollFailures: Int = 0
    /**
     * Successive polls that returned no commands. Drives an idle
     * backoff so a plugin sitting on the polling fallback doesn't keep
     * hammering the API every 2 s when there's nothing to do. Reset to
     * 0 whenever a poll delivers a command, so the first real work
     * after a quiet period still reaches the plugin quickly.
     */
    private var pollEmptyStreak: Int = 0

    data class RemoteCommand(
        val id: String,
        val sessionId: String,
        val pluginId: String,
        val type: String,
        val payload: JsonObject,
        val status: String,
        val createdAt: Long
    )

    interface CommandListener {
        fun onCommandReceived(command: RemoteCommand)
    }

    fun addListener(listener: CommandListener) {
        listeners.add(listener)
    }

    fun startPolling() {
        stopPolling()
        isRunning = true
        agentsRegistered = false
        startHeartbeat()
        startAgentsRetry()

        // Try SSE pull first. If the connection fails twice in a row we
        // assume the endpoint isn't available and switch to polling.
        if (System.getenv("CODEAM_DISABLE_SSE_PULL") == "1") {
            startPollingFallback()
        } else {
            connectSSE()
        }
        logger.info("Command relay started")
    }

    fun stopPolling() {
        if (!isRunning && sseThread == null && pollTask == null && heartbeatTimer == null) return
        isRunning = false
        cleanup()
    }

    private fun cleanup() {
        sseReconnectTask?.cancel(false)
        sseReconnectTask = null
        sseCall?.cancel()
        sseCall = null
        sseThread?.interrupt()
        sseThread = null
        pollTask?.cancel(false)
        pollTask = null
        stopHeartbeat()
        stopAgentsRetry()
    }

    // ─── SSE pull (primary) ──────────────────────────────────────────

    private fun connectSSE() {
        if (!isRunning) return
        val settings = SettingsService.getInstance()
        val pluginId = settings.ensurePluginId()

        val request = Request.Builder()
            .url("${settings.state.apiBaseUrl}/api/commands/pending/stream?pluginId=$pluginId")
            .addHeader("Accept", "text/event-stream")
            .addHeader("Cache-Control", "no-cache")
            .get()
            .withAuthHeaders()
            .build()

        val call = sseClient.newCall(request)
        sseCall = call

        val t = Thread({ runSseLoop(call) }, "command-relay-sse").apply { isDaemon = true }
        sseThread = t
        t.start()
    }

    private fun runSseLoop(call: Call) {
        try {
            val response = call.execute()
            try {
                if (response.code != 200) {
                    logger.debug("SSE status=${response.code}, will retry/fallback")
                    onSseFailure()
                    return
                }
                sseFailures = 0
                val source = response.body.source()
                val buffer = StringBuilder()
                while (isRunning && !Thread.currentThread().isInterrupted) {
                    val line = try {
                        source.readUtf8Line()
                    } catch (e: Exception) {
                        if (isRunning) onSseFailure()
                        return
                    } ?: break
                    if (line.isEmpty()) {
                        if (buffer.isNotEmpty()) {
                            handleSseFrame(buffer.toString())
                            buffer.setLength(0)
                        }
                    } else {
                        buffer.append(line).append('\n')
                    }
                }
                // Server-initiated close (Vercel timeout). Reconnect.
                if (isRunning) scheduleSseReconnect()
            } finally {
                response.close()
            }
        } catch (e: Exception) {
            logger.debug("SSE connection error: ${e.message}")
            if (isRunning) onSseFailure()
        }
    }

    private fun onSseFailure() {
        sseFailures += 1
        if (sseFailures >= 2) {
            logger.info("SSE unavailable after $sseFailures failures, falling back to polling")
            startPollingFallback()
            return
        }
        scheduleSseReconnect()
    }

    private fun scheduleSseReconnect() {
        if (!isRunning) return
        if (sseReconnectTask?.isDone == false) return
        val delay = computePollDelay(1000L, sseFailures)
        sseReconnectTask = scheduler.schedule({
            sseReconnectTask = null
            connectSSE()
        }, delay, TimeUnit.MILLISECONDS)
    }

    private fun handleSseFrame(frame: String) {
        var event = "message"
        val dataBuf = StringBuilder()
        for (line in frame.split('\n')) {
            when {
                line.startsWith("event: ") -> event = line.substring(7).trim()
                line.startsWith("data: ") -> dataBuf.append(line.substring(6))
            }
        }
        if (event != "commands" || dataBuf.isEmpty()) return
        try {
            val parsed = gson.fromJson(dataBuf.toString(), JsonObject::class.java)
            val arr = parsed.getAsJsonArray("commands") ?: return
            if (arr.size() == 0) return
            dispatchCommands(arr)
        } catch (e: Exception) {
            logger.debug("SSE parse error: ${e.message}")
        }
    }

    // ─── Polling fallback ────────────────────────────────────────────

    private fun startPollingFallback() {
        if (!isRunning) return
        if (pollTask?.isDone == false) return
        schedulePoll(0L)
    }

    private fun schedulePoll(delayMs: Long) {
        if (!isRunning) return
        pollTask = scheduler.schedule({ pollLoop() }, delayMs, TimeUnit.MILLISECONDS)
    }

    private fun pollLoop() {
        if (!isRunning) return
        pollOnce()
        if (!isRunning) return
        // Pick whichever streak is longer (failures vs empty) so the
        // backoff respects whichever signal is active. Cap empty at
        // a smaller exponent so a long idle plugin sits at ~30 s polls
        // instead of going to 5 min — fresh commands should still
        // land within the same poll cycle the user notices.
        val idleExp = min(pollEmptyStreak, 4)
        val effectiveFailures = max(pollFailures, idleExp)
        val delay = computePollDelay(2000L, effectiveFailures)
        schedulePoll(delay)
    }

    private fun pollOnce() {
        val settings = SettingsService.getInstance()
        val pluginId = settings.ensurePluginId()

        val request = Request.Builder()
            .url("${settings.state.apiBaseUrl}/api/commands/pending?pluginId=$pluginId")
            .get()
            .withAuthHeaders()
            .build()

        try {
            httpClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    pollFailures += 1
                    return
                }
                val body = response.body.string()
                pollFailures = 0
                val json = gson.fromJson(body, JsonObject::class.java)
                val data = json.getAsJsonArray("data")
                if (data == null || data.size() == 0) {
                    pollEmptyStreak += 1
                    return
                }
                // Real work arrived — collapse both streaks so the next
                // poll fires at the base 2 s cadence and the user feels
                // snappy.
                pollEmptyStreak = 0
                dispatchCommands(data)
            }
        } catch (e: Exception) {
            pollFailures += 1
            logger.debug("Poll failed (failures=$pollFailures): ${e.message}")
        }
    }

    private fun dispatchCommands(arr: JsonArray) {
        for (element in arr) {
            val obj = element.asJsonObject
            try {
                val cmd = RemoteCommand(
                    id = obj.get("id").asString,
                    sessionId = obj.get("sessionId").asString,
                    pluginId = obj.get("pluginId").asString,
                    type = obj.get("type").asString,
                    payload = obj.getAsJsonObject("payload") ?: JsonObject(),
                    status = obj.get("status").asString,
                    createdAt = obj.get("createdAt").asLong
                )
                logger.info("Received command: ${cmd.type} (${cmd.id})")
                listeners.forEach { it.onCommandReceived(cmd) }
            } catch (e: Exception) {
                logger.debug("Failed to dispatch command: ${e.message}")
            }
        }
    }

    /**
     * Exponential backoff with ±10% jitter, capped at 30 s. Matches the
     * shape used by the TypeScript CLI's `computePollDelay` so all
     * clients behave identically when the API is degraded.
     */
    private fun computePollDelay(baseMs: Long, failures: Int): Long {
        val exp = failures.coerceIn(0, 5)
        val raw = baseMs * (1L shl exp)
        val capped = raw.coerceAtMost(30_000L)
        val jitter = (capped * 0.1 * (Math.random() * 2 - 1)).toLong()
        return (capped + jitter).coerceAtLeast(baseMs)
    }

    // ─── Heartbeat + agents ──────────────────────────────────────────

    private fun startHeartbeat() {
        stopHeartbeat()
        reportOnline()
        heartbeatTimer = Timer("plugin-heartbeat", true).apply {
            scheduleAtFixedRate(object : TimerTask() {
                override fun run() {
                    reportOnline()
                }
            }, 20_000, 20_000)
        }
    }

    private fun stopHeartbeat() {
        heartbeatTimer?.cancel()
        heartbeatTimer = null
    }

    private fun startAgentsRetry() {
        stopAgentsRetry()
        reportAgents()
        agentsTimer = Timer("plugin-agents", true).apply {
            scheduleAtFixedRate(object : TimerTask() {
                override fun run() {
                    if (isRunning && !agentsRegistered) reportAgents()
                }
            }, 5_000, 5_000)
        }
    }

    private fun stopAgentsRetry() {
        agentsTimer?.cancel()
        agentsTimer = null
    }

    private fun reportOnline() {
        val settings = SettingsService.getInstance()
        val pluginId = settings.ensurePluginId()
        val body = JsonObject().apply {
            addProperty("pluginId", pluginId)
            addProperty("online", true)
        }
        val request = Request.Builder()
            .url("${settings.state.apiBaseUrl}/api/plugin/heartbeat")
            .post(gson.toJson(body).toRequestBody("application/json".toMediaType()))
            .withAuthHeaders()
            .build()
        try {
            httpClient.newCall(request).execute().close()
        } catch (e: Exception) {
            logger.debug("Failed to send heartbeat: ${e.message}")
        }
    }

    fun reportAgents() {
        val settings = SettingsService.getInstance()
        val pluginId = settings.ensurePluginId()
        val ide = IdeIntegrationService.getInstance()
        val agents = ide.detectInstalledAgents()

        val agentsArray = JsonArray()
        for (agent in agents) {
            agentsArray.add(JsonObject().apply {
                addProperty("id", agent.id)
                addProperty("name", agent.name)
                addProperty("icon", agent.icon)
                addProperty("installed", agent.installed)
            })
        }
        val body = JsonObject().apply {
            addProperty("pluginId", pluginId)
            add("agents", agentsArray)
        }
        val request = Request.Builder()
            .url("${settings.state.apiBaseUrl}/api/plugin/agents")
            .post(gson.toJson(body).toRequestBody("application/json".toMediaType()))
            .withAuthHeaders()
            .build()
        try {
            val response = httpClient.newCall(request).execute()
            response.use {
                if (it.isSuccessful) {
                    agentsRegistered = true
                    logger.info("Reported ${agents.size} agents to API")
                }
            }
        } catch (e: Exception) {
            logger.debug("Failed to report agents: ${e.message}")
        }
    }

    fun reportOffline() {
        val settings = SettingsService.getInstance()
        val pluginId = settings.ensurePluginId()
        val body = JsonObject().apply {
            addProperty("pluginId", pluginId)
            addProperty("online", false)
        }
        val request = Request.Builder()
            .url("${settings.state.apiBaseUrl}/api/plugin/heartbeat")
            .post(gson.toJson(body).toRequestBody("application/json".toMediaType()))
            .withAuthHeaders()
            .build()
        try {
            httpClient.newCall(request).execute().close()
            logger.info("Reported offline status")
        } catch (e: Exception) {
            logger.debug("Failed to report offline: ${e.message}")
        }
    }

    fun sendResult(commandId: String, status: String, result: JsonObject) {
        val settings = SettingsService.getInstance()

        val body = JsonObject().apply {
            addProperty("commandId", commandId)
            addProperty("status", status)
            add("result", result)
        }

        val request = Request.Builder()
            .url("${settings.state.apiBaseUrl}/api/commands/result")
            .post(gson.toJson(body).toRequestBody("application/json".toMediaType()))
            .withAuthHeaders()
            .build()

        try {
            httpClient.newCall(request).execute().close()
        } catch (e: Exception) {
            logger.error("Failed to send command result", e)
        }
    }

    companion object {
        fun getInstance(): CommandRelayService =
            ApplicationManager.getApplication().getService(CommandRelayService::class.java)
    }
}
