package com.windsurf.controller.services

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import org.java_websocket.client.WebSocketClient
import org.java_websocket.handshake.ServerHandshake
import java.net.URI
import java.util.Timer
import java.util.TimerTask
import java.util.concurrent.CopyOnWriteArrayList

@Service(Service.Level.APP)
class WebSocketService {

    private val logger = Logger.getInstance(WebSocketService::class.java)
    private val gson = Gson()
    private var client: WebSocketClient? = null
    private var heartbeatTimer: Timer? = null
    private var reconnectAttempts = 0
    private val maxReconnectAttempts = 10
    private val listeners = CopyOnWriteArrayList<WebSocketListener>()

    var isConnected: Boolean = false
        private set

    interface WebSocketListener {
        fun onConnected()
        fun onDisconnected(reason: String)
        fun onMessage(type: String, payload: JsonObject)
        fun onError(error: String)
    }

    fun addListener(listener: WebSocketListener) {
        listeners.add(listener)
    }

    fun removeListener(listener: WebSocketListener) {
        listeners.remove(listener)
    }

    fun connect(sessionId: String, token: String) {
        val settings = SettingsService.getInstance()
        val wsUrl = settings.state.apiBaseUrl
            .replace("https://", "wss://")
            .replace("http://", "ws://") + "/api/ws"

        disconnect()

        try {
            client = object : WebSocketClient(URI(wsUrl)) {
                override fun onOpen(handshake: ServerHandshake?) {
                    logger.info("WebSocket connected")
                    isConnected = true
                    reconnectAttempts = 0

                    val authMessage = JsonObject().apply {
                        addProperty("type", "auth")
                        add("payload", JsonObject().apply {
                            addProperty("token", token)
                            addProperty("pluginId", settings.ensurePluginId())
                            addProperty("sessionId", sessionId)
                        })
                        addProperty("timestamp", System.currentTimeMillis())
                    }
                    send(gson.toJson(authMessage))

                    startHeartbeat()
                    listeners.forEach { it.onConnected() }
                }

                override fun onMessage(message: String?) {
                    message ?: return
                    try {
                        val json = gson.fromJson(message, JsonObject::class.java)
                        val type = json.get("type")?.asString ?: return
                        val payload = json.getAsJsonObject("payload") ?: JsonObject()

                        when (type) {
                            "pong" -> logger.debug("Heartbeat pong received")
                            "auth_success" -> {
                                logger.info("WebSocket authenticated")
                                showNotification("Mobile Controller connected", NotificationType.INFORMATION)
                            }
                            "auth_error" -> {
                                val error = payload.get("message")?.asString ?: "Authentication failed"
                                logger.warn("WebSocket auth error: $error")
                                listeners.forEach { it.onError(error) }
                            }
                            else -> listeners.forEach { it.onMessage(type, payload) }
                        }
                    } catch (e: Exception) {
                        logger.error("Error parsing WebSocket message", e)
                    }
                }

                override fun onClose(code: Int, reason: String?, remote: Boolean) {
                    logger.info("WebSocket closed: $code - $reason")
                    isConnected = false
                    stopHeartbeat()
                    listeners.forEach { it.onDisconnected(reason ?: "Connection closed") }

                    if (remote && reconnectAttempts < maxReconnectAttempts) {
                        scheduleReconnect(sessionId, token)
                    }
                }

                override fun onError(ex: Exception?) {
                    logger.error("WebSocket error", ex)
                    listeners.forEach { it.onError(ex?.message ?: "Unknown error") }
                }
            }
            client?.connect()
        } catch (e: Exception) {
            logger.error("Failed to create WebSocket connection", e)
        }
    }

    fun disconnect() {
        stopHeartbeat()
        client?.close()
        client = null
        isConnected = false
    }

    fun sendMessage(type: String, payload: JsonObject) {
        if (!isConnected) {
            logger.warn("Cannot send message: not connected")
            return
        }

        val message = JsonObject().apply {
            addProperty("type", type)
            add("payload", payload)
            addProperty("timestamp", System.currentTimeMillis())
            addProperty("messageId", java.util.UUID.randomUUID().toString())
        }

        client?.send(gson.toJson(message))
    }

    fun sendAgentEvent(eventType: String, sessionId: String, data: JsonObject) {
        val payload = JsonObject().apply {
            addProperty("type", eventType)
            addProperty("sessionId", sessionId)
            add("data", data)
            addProperty("timestamp", System.currentTimeMillis())
        }
        sendMessage("agent_event", payload)
    }

    private fun startHeartbeat() {
        stopHeartbeat()
        val interval = SettingsService.getInstance().state.heartbeatIntervalMs
        heartbeatTimer = Timer("ws-heartbeat", true).apply {
            scheduleAtFixedRate(object : TimerTask() {
                override fun run() {
                    if (isConnected) {
                        val ping = JsonObject().apply {
                            addProperty("type", "ping")
                            addProperty("timestamp", System.currentTimeMillis())
                        }
                        client?.send(gson.toJson(ping))
                    }
                }
            }, interval, interval)
        }
    }

    private fun stopHeartbeat() {
        heartbeatTimer?.cancel()
        heartbeatTimer = null
    }

    private fun scheduleReconnect(sessionId: String, token: String) {
        reconnectAttempts++
        val delay = minOf(1000L * (1 shl reconnectAttempts), 30000L)
        logger.info("Scheduling reconnect attempt $reconnectAttempts in ${delay}ms")

        Timer("ws-reconnect", true).schedule(object : TimerTask() {
            override fun run() {
                if (!isConnected) {
                    connect(sessionId, token)
                }
            }
        }, delay)
    }

    private fun showNotification(content: String, type: NotificationType) {
        ApplicationManager.getApplication().invokeLater {
            NotificationGroupManager.getInstance()
                .getNotificationGroup("CodeAgent-Mobile")
                .createNotification(content, type)
                .notify(null)
        }
    }

    companion object {
        fun getInstance(): WebSocketService =
            ApplicationManager.getApplication().getService(WebSocketService::class.java)
    }
}
