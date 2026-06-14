package com.windsurf.controller.services

import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.Credentials
import com.intellij.credentialStore.generateServiceName
import com.intellij.ide.passwordSafe.PasswordSafe
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.windsurf.controller.DEFAULT_API_BASE_URL
import com.windsurf.controller.resolveApiBaseUrl

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
        var apiBaseUrl: String = resolveApiBaseUrl(),
        var pluginId: String = "",
        var autoConnect: Boolean = true,
        var showNotifications: Boolean = true,
        var heartbeatIntervalMs: Long = 30000,
        var recentSessions: MutableList<RecentSession> = mutableListOf(),
        // SEC crit1 (#813): per-install proof-of-possession secret.
        // Generated locally, never sent in the clear; sha256 is sent at
        // enrollment and the raw value replayed as the X-Plugin-Poll-Secret
        // header on /status + /reconnect, so the backend returns the auth
        // token + owner PII only to this install, not to anyone who learns
        // the (non-secret) pluginId.
        var pollSecret: String = "",
        /**
         * Legacy slot for older installs. The auth token now lives in
         * PasswordSafe (OS keychain on macOS/Win, libsecret on Linux,
         * encrypted KeePass file otherwise). Any non-empty value here
         * is migrated out on loadState and blanked.
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
    // Mirror of the PasswordSafe value so getPluginAuthToken stays
    // cheap and synchronous. Populated lazily on first read or
    // immediately after loadState migrates a legacy plaintext token.
    private var cachedAuthToken: String? = null
    private var cacheLoaded = false

    override fun getState(): State = myState

    override fun loadState(state: State) {
        myState = state
        // Env-var override wins over persisted state — without this,
        // a user who flips `CODEAM_TEST_MODE=1` mid-session keeps
        // hitting prod because the saved `apiBaseUrl` in
        // windsurf-controller.xml takes precedence on every load.
        // resolveApiBaseUrl() returns prod when no env var is set,
        // so prod users still respect any custom override they
        // configured in Settings.
        val resolved = resolveApiBaseUrl()
        if (resolved != DEFAULT_API_BASE_URL && myState.apiBaseUrl != resolved) {
            myState.apiBaseUrl = resolved
        }
        val legacy = myState.pluginAuthToken
        if (legacy.isNotEmpty()) {
            writeAuthTokenToPasswordSafe(legacy)
            cachedAuthToken = legacy
            cacheLoaded = true
            myState.pluginAuthToken = ""
        }
    }

    fun ensurePluginId(): String {
        if (myState.pluginId.isBlank()) {
            myState.pluginId = java.util.UUID.randomUUID().toString()
        }
        return myState.pluginId
    }

    // SEC crit1 (#813): lazily generate + persist the proof-of-possession
    // secret (32 random bytes, base64url). Returned raw for the
    // X-Plugin-Poll-Secret header; only its sha256 leaves at enrollment.
    fun ensurePollSecret(): String {
        if (myState.pollSecret.isBlank()) {
            val bytes = ByteArray(32)
            java.security.SecureRandom().nextBytes(bytes)
            myState.pollSecret =
                java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        }
        return myState.pollSecret
    }

    // sha256(pollSecret) as lowercase hex — sent at enrollment so the
    // backend can verify the raw secret on later /status + /reconnect.
    fun pollSecretHash(): String {
        val digest = java.security.MessageDigest.getInstance("SHA-256")
            .digest(ensurePollSecret().toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }

    fun getPluginAuthToken(): String? {
        if (!cacheLoaded) {
            cachedAuthToken = readAuthTokenFromPasswordSafe()
            cacheLoaded = true
        }
        return cachedAuthToken?.takeIf { it.isNotEmpty() }
    }

    fun setPluginAuthToken(token: String?) {
        cachedAuthToken = token
        cacheLoaded = true
        if (token.isNullOrEmpty()) {
            PasswordSafe.instance.set(authTokenAttributes, null)
        } else {
            writeAuthTokenToPasswordSafe(token)
        }
    }

    private fun writeAuthTokenToPasswordSafe(token: String) {
        PasswordSafe.instance.set(authTokenAttributes, Credentials(null, token))
    }

    private fun readAuthTokenFromPasswordSafe(): String? =
        PasswordSafe.instance.get(authTokenAttributes)?.getPasswordAsString()

    private val authTokenAttributes: CredentialAttributes =
        CredentialAttributes(generateServiceName("CodeAgent Mobile", "pluginAuthToken"))

    companion object {
        fun getInstance(): SettingsService =
            ApplicationManager.getApplication().getService(SettingsService::class.java)
    }
}
