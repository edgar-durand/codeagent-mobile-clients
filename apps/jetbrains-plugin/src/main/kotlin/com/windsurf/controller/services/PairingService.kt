package com.windsurf.controller.services

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.InetAddress
import java.util.Timer
import java.util.TimerTask
import java.util.concurrent.TimeUnit

@Service(Service.Level.APP)
class PairingService {

    private val logger = Logger.getInstance(PairingService::class.java)
    private val gson = Gson()
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()
    private var pollingTimer: Timer? = null

    data class PairedUserInfo(
        val name: String,
        val email: String,
        val plan: String,
        val currentPeriodEnd: String? = null
    )

    interface PairingListener {
        fun onPaired(sessionId: String)
    }

    var pairedUser: PairedUserInfo? = null
        private set

    var currentSessionId: String? = null
        private set

    private val listeners = mutableListOf<PairingListener>()

    fun addListener(listener: PairingListener) {
        listeners.add(listener)
    }

    /**
     * Sealed result for [requestPairingCode]:
     * - [Code]    — successful code returned by the backend.
     * - [Blocked] — API host unreachable (preflight or transport error / no HTTP response).
     *               Callers should offer the cloud-fallback panel.
     * - [None]    — backend returned a non-2xx HTTP status (real server error; treat as
     *               the existing null path — do NOT show the cloud-fallback panel).
     */
    sealed interface PairingCodeResult {
        data class Code(val code: String, val expiresAt: Long) : PairingCodeResult
        data object Blocked : PairingCodeResult
        data object None : PairingCodeResult
    }

    /**
     * Request a pairing code from the backend.
     *
     * Classification (mirrors VS Code pairing.service.ts):
     *  • Preflight BLOCKED  → [PairingCodeResult.Blocked]  (no HTTP attempt)
     *  • Transport error    → [PairingCodeResult.Blocked]  (IOException/timeout — no HTTP response)
     *  • Non-2xx HTTP status → [PairingCodeResult.None]    (real server error — unchanged path)
     *  • 2xx success        → [PairingCodeResult.Code]
     *
     * Must be called from a background thread (OkHttp blocks; do NOT call on the EDT).
     */
    fun requestPairingCode(): PairingCodeResult {
        val settings = SettingsService.getInstance()

        // Preflight: if the API host is unreachable (VPN/firewall/allowlist),
        // surface the cloud fallback instead of a cryptic pairing failure.
        val reachability = ConnectivityChecker.checkApiReachable(settings.state.apiBaseUrl)
        if (reachability == Reachability.BLOCKED) {
            logger.info("[pairing] API unreachable (preflight) — offering cloud fallback")
            return PairingCodeResult.Blocked
        }

        val pluginId = settings.ensurePluginId()

        val body = JsonObject().apply {
            addProperty("pluginId", pluginId)
            addProperty("ideName", "WebStorm")
            addProperty("ideVersion", com.intellij.openapi.application.ApplicationInfo.getInstance().fullVersion)
            addProperty("hostname", getHostname())
            // SEC crit1 (#813): enroll the PoP hash so /status + /reconnect
            // require this install's secret. Older backends ignore it.
            addProperty("pluginSecretHash", settings.pollSecretHash())
        }

        val request = Request.Builder()
            .url("${settings.state.apiBaseUrl}/api/pairing/code")
            .post(gson.toJson(body).toRequestBody("application/json".toMediaType()))
            .build()

        return try {
            val response = httpClient.newCall(request).execute()
            val responseBody = response.body?.string() ?: return PairingCodeResult.None

            if (response.isSuccessful) {
                val json = gson.fromJson(responseBody, JsonObject::class.java)
                val data = json.getAsJsonObject("data")
                val result = PairingCodeResult.Code(
                    code = data.get("code").asString,
                    expiresAt = data.get("expiresAt").asLong
                )
                startPollingForPairing()
                result
            } else {
                // Non-2xx HTTP response — real server error (NOT a connectivity block).
                logger.warn("Failed to get pairing code: $responseBody")
                PairingCodeResult.None
            }
        } catch (e: IOException) {
            // Transport error: no HTTP response received (connection refused, timeout, DNS
            // failure, etc.) — classify as Blocked so the caller shows the cloud-fallback
            // panel. This mirrors VS Code's postJson reject path.
            logger.info("[pairing] request failed (transport) — offering cloud fallback: ${e.message}")
            PairingCodeResult.Blocked
        } catch (e: Exception) {
            // Any other unexpected error — treat as a real error, not a connectivity block.
            logger.error("Error requesting pairing code", e)
            PairingCodeResult.None
        }
    }

    fun stopPolling() {
        pollingTimer?.cancel()
        pollingTimer = null
    }

    private fun startPollingForPairing() {
        stopPolling()
        pollingTimer = Timer("pairing-poll", true).apply {
            scheduleAtFixedRate(object : TimerTask() {
                override fun run() {
                    checkPairingStatus()
                }
            }, 2000, 3000)
        }

        Timer("pairing-poll-timeout", true).schedule(object : TimerTask() {
            override fun run() {
                stopPolling()
            }
        }, 300_000)
    }

    private fun checkPairingStatus() {
        val settings = SettingsService.getInstance()
        val pluginId = settings.ensurePluginId()

        val request = Request.Builder()
            .url("${settings.state.apiBaseUrl}/api/pairing/status?pluginId=$pluginId")
            // SEC crit1 (#813): replay the PoP secret so the gated /status
            // returns the token + PII (the plugin reads the token here).
            .header("X-Plugin-Poll-Secret", settings.ensurePollSecret())
            .get()
            .build()

        try {
            val response = httpClient.newCall(request).execute()
            val body = response.body?.string() ?: return

            if (response.isSuccessful) {
                val json = gson.fromJson(body, JsonObject::class.java)
                val data = json.getAsJsonObject("data")
                val paired = data.get("paired").asBoolean
                if (paired) {
                    val sessionId = data.get("sessionId").asString
                    val userObj = data.getAsJsonObject("user")
                    if (userObj != null) {
                        pairedUser = PairedUserInfo(
                            name = userObj.get("name")?.asString ?: "",
                            email = userObj.get("email")?.asString ?: "",
                            plan = userObj.get("plan")?.asString ?: "FREE",
                            currentPeriodEnd = userObj.get("currentPeriodEnd")?.takeIf { !it.isJsonNull }?.asString
                        )
                    }
                    // Persist the per-pairing token. Replayed as
                    // `X-Plugin-Auth-Token` on every authed call so
                    // we still pass auth after the legacy fallback
                    // expires (2026-05-25).
                    val rawToken = data.get("pluginAuthToken")?.takeIf { !it.isJsonNull }?.asString
                    if (!rawToken.isNullOrEmpty()) {
                        SettingsService.getInstance().setPluginAuthToken(rawToken)
                        // The new token clears any prior 401 — re-arm the
                        // "session expired" notification gate for the next failure.
                        CommandRelayService.getInstance().resetAuthFailureGate()
                    }
                    currentSessionId = sessionId
                    logger.info("Pairing detected! Session: $sessionId, user: ${pairedUser?.email}")
                    stopPolling()
                    saveCurrentSession()
                    listeners.forEach { it.onPaired(sessionId) }
                }
            }
        } catch (e: Exception) {
            logger.debug("Polling error: ${e.message}")
        }
    }

    private fun saveCurrentSession() {
        val sid = currentSessionId ?: return
        val user = pairedUser ?: return
        val settings = SettingsService.getInstance()
        settings.addRecentSession(SettingsService.RecentSession(
            sessionId = sid,
            userName = user.name,
            userEmail = user.email,
            userPlan = user.plan,
            connectedAt = System.currentTimeMillis()
        ))
    }

    fun clearCurrentSession() {
        currentSessionId = null
        pairedUser = null
        SettingsService.getInstance().setPluginAuthToken(null)
        // Tear down the Path B file watcher - it would otherwise keep
        // POSTing to a session that no longer exists. The service is
        // idempotent on stop(), safe to call when never started.
        try {
            FileWatcherService.getInstance().stop()
        } catch (e: Exception) {
            logger.debug("Failed to stop FileWatcherService on unpair: ${e.message}")
        }
    }

    fun onReconnected(sessionId: String, user: PairedUserInfo) {
        currentSessionId = sessionId
        pairedUser = user
        saveCurrentSession()
        listeners.forEach { it.onPaired(sessionId) }
    }

    private fun getHostname(): String {
        return try {
            InetAddress.getLocalHost().hostName
        } catch (e: Exception) {
            "unknown"
        }
    }

    companion object {
        fun getInstance(): PairingService =
            ApplicationManager.getApplication().getService(PairingService::class.java)
    }
}
