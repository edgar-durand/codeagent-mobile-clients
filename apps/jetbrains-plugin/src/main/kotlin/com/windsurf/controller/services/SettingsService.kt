package com.windsurf.controller.services

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

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
        var apiBaseUrl: String = "https://codeagent-mobile-api.vercel.app",
        var pluginId: String = "",
        var autoConnect: Boolean = true,
        var showNotifications: Boolean = true,
        var heartbeatIntervalMs: Long = 30000,
        var recentSessions: MutableList<RecentSession> = mutableListOf()
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

    companion object {
        fun getInstance(): SettingsService =
            ApplicationManager.getApplication().getService(SettingsService::class.java)
    }
}
