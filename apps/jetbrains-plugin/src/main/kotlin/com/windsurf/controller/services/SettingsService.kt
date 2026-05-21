package com.windsurf.controller.services

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.windsurf.controller.DEFAULT_API_BASE_URL

@Service(Service.Level.APP)
@State(
    name = "WindsurfControllerSettings",
    storages = [Storage("windsurf-controller.xml")]
)
class SettingsService : PersistentStateComponent<SettingsService.State> {

    data class RecentSession(
        var sessionId: String = "",
        var userName: String = "",
        var userEmail: String = "",
        var userPlan: String = "FREE",
        var connectedAt: Long = 0
    )

    data class State(
        var apiBaseUrl: String = DEFAULT_API_BASE_URL,
        var pluginId: String = "",
        var autoConnect: Boolean = true,
        var showNotifications: Boolean = true,
        var heartbeatIntervalMs: Long = 30000,
        var recentSessions: MutableList<RecentSession> = mutableListOf(),
        /**
         * Per-pairing token returned by the backend at
         * `/api/pairing/status` once `paired: true`. Replayed as
         * `X-Plugin-Auth-Token` on every authed call so we still
         * pass auth after the legacy fallback expires (2026-05-25).
         * Empty string when not yet paired.
         */
        var pluginAuthToken: String = ""
    )

    fun addRecentSession(session: RecentSession) {
        myState.recentSessions.removeAll { it.sessionId == session.sessionId }
        myState.recentSessions.add(0, session)
        if (myState.recentSessions.size > 10) {
            myState.recentSessions = myState.recentSessions.take(10).toMutableList()
        }
    }

    fun removeRecentSession(sessionId: String) {
        myState.recentSessions.removeAll { it.sessionId == sessionId }
    }

    fun getRecentSessions(): List<RecentSession> = myState.recentSessions.toList()

    private var myState = State()

    override fun getState(): State = myState

    override fun loadState(state: State) {
        myState = state
    }

    fun ensurePluginId(): String {
        if (myState.pluginId.isBlank()) {
            myState.pluginId = java.util.UUID.randomUUID().toString()
        }
        return myState.pluginId
    }

    fun getPluginAuthToken(): String? =
        myState.pluginAuthToken.takeIf { it.isNotEmpty() }

    fun setPluginAuthToken(token: String?) {
        myState.pluginAuthToken = token ?: ""
    }

    companion object {
        fun getInstance(): SettingsService =
            ApplicationManager.getApplication().getService(SettingsService::class.java)
    }
}
