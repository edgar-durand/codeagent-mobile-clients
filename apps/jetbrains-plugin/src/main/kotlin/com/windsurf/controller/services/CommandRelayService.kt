package com.windsurf.controller.services

import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.Timer
import java.util.TimerTask
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

@Service(Service.Level.APP)
class CommandRelayService {

    private val logger = Logger.getInstance(CommandRelayService::class.java)
    private val gson = Gson()
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()
    private var pollTimer: Timer? = null
    private var heartbeatTimer: Timer? = null
    private val listeners = CopyOnWriteArrayList<CommandListener>()

    var isPolling: Boolean = false
        private set

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
        isPolling = true
        pollTimer = Timer("command-poll", true).apply {
            scheduleAtFixedRate(object : TimerTask() {
                override fun run() {
                    fetchPendingCommands()
                }
            }, 0, 2000)
        }
        startHeartbeat()
        logger.info("Command polling started")
    }

    fun stopPolling() {
        pollTimer?.cancel()
        pollTimer = null
        stopHeartbeat()
        isPolling = false
    }

    private fun startHeartbeat() {
        stopHeartbeat()
        reportOnline()
        heartbeatTimer = Timer("plugin-heartbeat", true).apply {
            scheduleAtFixedRate(object : TimerTask() {
                override fun run() {
                    reportOnline()
                }
            }, 20000, 20000)
        }
    }

    private fun stopHeartbeat() {
        heartbeatTimer?.cancel()
        heartbeatTimer = null
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
            .build()
        try {
            httpClient.newCall(request).execute().close()
            logger.info("Reported ${agents.size} agents to API")
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
            .build()
        try {
            httpClient.newCall(request).execute().close()
            logger.info("Reported offline status")
        } catch (e: Exception) {
            logger.debug("Failed to report offline: ${e.message}")
        }
    }

    private fun fetchPendingCommands() {
        val settings = SettingsService.getInstance()
        val pluginId = settings.ensurePluginId()

        val request = Request.Builder()
            .url("${settings.state.apiBaseUrl}/api/commands/pending?pluginId=$pluginId")
            .get()
            .build()

        try {
            val response = httpClient.newCall(request).execute()
            val body = response.body?.string() ?: return

            if (response.isSuccessful) {
                val json = gson.fromJson(body, JsonObject::class.java)
                val data = json.getAsJsonArray("data") ?: return

                for (element in data) {
                    val obj = element.asJsonObject
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
                }
            }
        } catch (e: Exception) {
            logger.debug("Command poll error: ${e.message}")
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
