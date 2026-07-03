package com.windsurf.controller.services

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.diagnostic.Logger
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * Pushes captured output chunks to /api/commands/output. Owns the
 * outbound HTTP shape only — capture / scraping / monitor lifecycle
 * stays in AgentOutputMonitor.
 *
 * Wire shape (matches the CLI's canonical chunk in
 * apps/cli/src/services/output.service.ts:126 and VS Code's
 * AgentOutputMonitor.pushOutput):
 *   POST /api/commands/output
 *   { sessionId, pluginId, type, content?, done }
 *
 * Both methods fire on a background thread — neither waits for the
 * response since the relay's chunk router is fire-and-forget.
 */
internal object AgentOutputPublisher {

    private val logger = Logger.getInstance(AgentOutputPublisher::class.java)
    private val gson = Gson()
    private val client = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build()

    /**
     * Latched when the backend rejects our plugin-auth token as
     * invalid (401/403) — the pairing is gone server-side, so every
     * further post would just spam dead-token requests while the
     * user's phone silently receives nothing (2026-06-28 incident:
     * 401 x34 on /api/commands/output). Mirrors the CLI's
     * ChunkEmitter/AcpPublisher latch; cleared on re-pair because
     * pairing replaces the stored token and restarts the plugin's
     * services.
     */
    @Volatile
    private var pairingInvalid = false

    fun resetPairingLatch() {
        pairingInvalid = false
    }

    private fun handleAuthRejection(code: Int) {
        if (pairingInvalid) return
        pairingInvalid = true
        logger.warn("Pairing invalid (HTTP $code) — output publisher latched, no further posts")
        NotificationGroupManager.getInstance()
            .getNotificationGroup("CodeAgent-Mobile")
            .createNotification(
                "CodeAgent pairing is no longer valid",
                "The mobile pairing for this IDE was removed or expired, so agent output can't reach your phone. Re-pair from the CodeAgent panel to reconnect.",
                NotificationType.WARNING,
            )
            .notify(null)
    }

    fun pushOutput(sessionId: String, type: String, content: String, done: Boolean) {
        if (pairingInvalid) return
        Thread {
            val settings = SettingsService.getInstance()
            val pluginId = settings.ensurePluginId()
            val body = JsonObject().apply {
                addProperty("sessionId", sessionId)
                addProperty("pluginId", pluginId)
                addProperty("type", type)
                addProperty("content", content)
                addProperty("done", done)
            }
            val request = Request.Builder()
                .url("${settings.state.apiBaseUrl}/api/commands/output")
                .post(gson.toJson(body).toRequestBody("application/json".toMediaType()))
                .withAuthHeaders()
                .build()
            try {
                client.newCall(request).execute().use { response ->
                    if (response.code == 401 || response.code == 403) {
                        handleAuthRejection(response.code)
                    } else {
                        logger.info("Pushed output to API: type=$type, done=$done, length=${content.length}")
                    }
                }
            } catch (e: Exception) {
                logger.debug("Failed to push output: ${e.message}")
            }
        }.start()
    }

    fun clearRemoteOutput(sessionId: String) {
        if (pairingInvalid) return
        Thread {
            // Wire shape matches the CLI's canonical `clear` chunk
            // (apps/cli/src/services/output.service.ts:126) — POST with
            // type:"clear" so the backend's chunk router handles it the
            // same regardless of which client sent it.
            val settings = SettingsService.getInstance()
            val pluginId = settings.ensurePluginId()
            val body = JsonObject().apply {
                addProperty("sessionId", sessionId)
                addProperty("pluginId", pluginId)
                addProperty("type", "clear")
            }
            val request = Request.Builder()
                .url("${settings.state.apiBaseUrl}/api/commands/output")
                .post(gson.toJson(body).toRequestBody("application/json".toMediaType()))
                .withAuthHeaders()
                .build()
            try {
                client.newCall(request).execute().use { response ->
                    if (response.code == 401 || response.code == 403) handleAuthRejection(response.code)
                }
            } catch (e: Exception) {
                logger.debug("Failed to clear output: ${e.message}")
            }
        }.start()
    }
}
