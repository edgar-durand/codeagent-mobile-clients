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

    data class PairingCodeResult(
        val code: String,
        val expiresAt: Long
    )

    fun requestPairingCode(): PairingCodeResult? {
        val settings = SettingsService.getInstance()
        val pluginId = settings.ensurePluginId()

        val body = JsonObject().apply {
            addProperty("pluginId", pluginId)
            addProperty("ideName", "WebStorm")
            addProperty("ideVersion", com.intellij.openapi.application.ApplicationInfo.getInstance().fullVersion)
            addProperty("hostname", getHostname())
        }

        val request = Request.Builder()
            .url("${settings.state.apiBaseUrl}/api/pairing/code")
            .post(gson.toJson(body).toRequestBody("application/json".toMediaType()))
            .build()

        return try {
            val response = httpClient.newCall(request).execute()
            val responseBody = response.body?.string() ?: return null

            if (response.isSuccessful) {
                val json = gson.fromJson(responseBody, JsonObject::class.java)
                val data = json.getAsJsonObject("data")
                val result = PairingCodeResult(
                    code = data.get("code").asString,
                    expiresAt = data.get("expiresAt").asLong
                )
                startPollingForPairing()
                result
            } else {
                logger.warn("Failed to get pairing code: $responseBody")
                null
            }
        } catch (e: Exception) {
            logger.error("Error requesting pairing code", e)
            null
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
