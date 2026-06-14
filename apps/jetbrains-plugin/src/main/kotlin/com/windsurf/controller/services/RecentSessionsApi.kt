package com.windsurf.controller.services

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.openapi.diagnostic.Logger
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * HTTP plumbing for the "Recent Sessions" rail in the JetBrains
 * tool window — reconnect to an existing paired session, or delete
 * it from the backend. Fire-and-forget on a background thread; the
 * caller passes a typed result callback that the API invokes from
 * the same background thread (the caller is responsible for
 * hopping back to EDT before touching Swing).
 *
 * Pure HTTP boundary — no Swing dialogs, no parent components. The
 * panel used to inline both methods + 4 JOptionPane dialogs in
 * each branch; that cross-cuts the rendering concern with the wire
 * concern. Here the API only owns the network shape; the panel
 * owns the dialog shape.
 */
internal object RecentSessionsApi {

    private val logger = Logger.getInstance(RecentSessionsApi::class.java)
    private val gson = Gson()
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    /** Discriminated result from `reconnect()`. */
    sealed class ReconnectResult {
        /** Backend accepted the reconnect. Pair-listeners should fire next. */
        data class Success(
            val sessionId: String,
            val userInfo: PairingService.PairedUserInfo,
        ) : ReconnectResult()
        /** Backend returned 200 but `success:false` — session record is gone. */
        object SessionExpired : ReconnectResult()
        /** HTTP non-2xx. */
        object Failed : ReconnectResult()
        /** Network/parse exception. `message` is the exception summary. */
        data class Error(val message: String) : ReconnectResult()
    }

    /**
     * Fire the `/api/pairing/reconnect` POST in the background. The
     * `callback` runs on the OkHttp worker thread — hop to EDT
     * before touching Swing.
     */
    fun reconnect(session: SettingsService.RecentSession, callback: (ReconnectResult) -> Unit) {
        Thread {
            val settings = SettingsService.getInstance()
            val pluginId = settings.ensurePluginId()
            val body = JsonObject().apply {
                addProperty("pluginId", pluginId)
                addProperty("sessionId", session.sessionId)
            }
            val request = Request.Builder()
                .url("${settings.state.apiBaseUrl}/api/pairing/reconnect")
                .post(gson.toJson(body).toRequestBody("application/json".toMediaType()))
                .withAuthHeaders()
                // SEC crit1 (#813): prove possession on the gated /reconnect.
                .header("X-Plugin-Poll-Secret", settings.ensurePollSecret())
                .build()
            try {
                val response = client.newCall(request).execute()
                val responseBody = response.body?.string()
                if (!response.isSuccessful || responseBody == null) {
                    callback(ReconnectResult.Failed)
                    return@Thread
                }
                val json = gson.fromJson(responseBody, JsonObject::class.java)
                val success = json.get("success")?.asBoolean ?: false
                if (!success) {
                    callback(ReconnectResult.SessionExpired)
                    return@Thread
                }
                val dataObj = json.getAsJsonObject("data")
                val userObj = dataObj?.getAsJsonObject("user")
                val plan = userObj?.get("plan")?.asString ?: session.userPlan
                val periodEnd = userObj?.get("currentPeriodEnd")
                    ?.takeIf { !it.isJsonNull }?.asString

                // Persist the freshly-replayed plugin auth token so
                // post-reconnect calls (e.g. the mint-cli-token flow
                // that drives Claude Code auto-pair) have it
                // available. Sessions paired before plugin v2.x never
                // had the token persisted; reconnect is their upgrade
                // path.
                val refreshedAuthToken = dataObj?.get("pluginAuthToken")
                    ?.takeIf { !it.isJsonNull }?.asString
                if (!refreshedAuthToken.isNullOrEmpty()) {
                    settings.setPluginAuthToken(refreshedAuthToken)
                }

                callback(
                    ReconnectResult.Success(
                        sessionId = session.sessionId,
                        userInfo = PairingService.PairedUserInfo(
                            name = session.userName,
                            email = session.userEmail,
                            plan = plan,
                            currentPeriodEnd = periodEnd,
                        ),
                    ),
                )
            } catch (e: Exception) {
                logger.debug("Reconnect threw: ${e.message}")
                callback(ReconnectResult.Error(e.message ?: e.javaClass.simpleName))
            }
        }.start()
    }

    /**
     * Fire the plugin-authed unpair (`POST /api/pairing/unpair`) in
     * the background. The legacy DELETE on `/sessions/<id>` is
     * JWT-authed and unreachable from a plugin process, so the
     * server-side row never got deleted — mobile kept showing the
     * stale device. POSTing here with `X-Plugin-Auth-Token` + body
     * `{ sessionId, pluginId }` deletes the row and fires
     * `paired_session_removed` on the SSE bus.
     *
     * On success, the SettingsService recent-sessions entry is also
     * removed before `onDeleted` fires. `onError` is invoked on a
     * non-2xx or thrown exception with the message.
     */
    fun deleteSession(
        session: SettingsService.RecentSession,
        onDeleted: () -> Unit,
        onError: (String) -> Unit,
    ) {
        Thread {
            try {
                postUnpair(session.sessionId)
                SettingsService.getInstance().removeRecentSession(session.sessionId)
                onDeleted()
            } catch (e: Exception) {
                logger.debug("Unpair threw: ${e.message}")
                onError(e.message ?: e.javaClass.simpleName)
            }
        }.start()
    }

    /**
     * Fire-and-forget plugin-authed unpair for the current session.
     * Used by the Disconnect button so the mobile-app card drops
     * the moment the plugin asks to disconnect, instead of waiting
     * for offline detection. Local cleanup (clearCurrentSession,
     * remove from recent) is the caller's responsibility.
     */
    fun unpairAsync(sessionId: String) {
        Thread {
            try { postUnpair(sessionId) } catch (e: Exception) {
                logger.debug("unpairAsync threw: ${e.message}")
            }
        }.start()
    }

    private fun postUnpair(sessionId: String) {
        val settings = SettingsService.getInstance()
        val body = JsonObject().apply {
            addProperty("sessionId", sessionId)
            addProperty("pluginId", settings.ensurePluginId())
        }
        val request = Request.Builder()
            .url("${settings.state.apiBaseUrl}/api/pairing/unpair")
            .post(gson.toJson(body).toRequestBody("application/json".toMediaType()))
            .withAuthHeaders()
            .build()
        client.newCall(request).execute().close()
    }
}
