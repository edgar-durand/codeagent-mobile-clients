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

    /** Back-to-back throttled/failed polls; drives the exponential backoff. */
    private var consecutiveThrottles = 0

    /** Epoch ms at which this pairing attempt gives up (replaces a leaked Timer). */
    private var pollingDeadlineAt = 0L
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
            // ⚠️ Repo y rama, como los envian el CLI y el plugin de VS Code.
            //
            // El backend acepta `branch` desde hace tiempo y las apps titulan la
            // sesion con el repo — pero este plugin no enviaba ninguno de los
            // dos, PESE A CALCULARLOS: `detectRepoSlug()` y `gitStatus()` ya
            // existian y solo se usaban para redactar el texto de un dialogo de
            // fallback. Resultado: en la lista de sesiones, toda sesion de
            // JetBrains salia sin proyecto y sin rama, y habia que titularla por
            // la herramienta.
            //
            // Best-effort: si el proyecto no es un repo git, o no tiene remoto
            // de GitHub, se omiten y el emparejamiento sigue igual que antes.
            runCatching {
                val ops = ProjectOpsService.getInstance()
                ops.detectRepoSlug()?.let {
                    addProperty("repoIdentifier", "${'$'}{it.owner}/${'$'}{it.repo}")
                }
                ops.gitStatus()
                    .get("branch")
                    ?.takeIf { !it.isJsonNull }
                    ?.asString
                    ?.takeIf { it.isNotBlank() && it != "(detached)" }
                    ?.let { addProperty("branch", it) }
            }.onFailure {
                logger.info("[pairing] no git context for this project: ${'$'}{it.message}")
            }
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
        consecutiveThrottles = 0
        pollingDeadlineAt = System.currentTimeMillis() + POLL_WINDOW_MS
        pollingTimer = Timer("pairing-poll", true)
        schedulePoll(2000)
    }

    /**
     * Schedule ONE poll, `delayMs` from now.
     *
     * Deliberately a single-shot `schedule` that re-arms itself rather than
     * `scheduleAtFixedRate`: the HTTP call below is synchronous inside the
     * TimerTask, and fixed-RATE scheduling fires catch-up executions
     * back-to-back whenever a response is slower than the period — so a slow or
     * rate-limited backend turned this loop into a burst generator. Fixed
     * DELAY also lets each poll pick its own wait, which is what honouring
     * `Retry-After` requires.
     *
     * The old code additionally leaked one `Timer` per pairing attempt for the
     * 5-minute cutoff; the deadline is now just a timestamp checked here.
     */
    private fun schedulePoll(delayMs: Long) {
        val timer = pollingTimer ?: return
        if (System.currentTimeMillis() >= pollingDeadlineAt) {
            stopPolling()
            return
        }
        try {
            timer.schedule(object : TimerTask() {
                override fun run() {
                    val outcome = checkPairingStatus()
                    if (outcome == null) return // paired → polling already stopped
                    consecutiveThrottles =
                        if (outcome.throttled) consecutiveThrottles + 1 else 0
                    schedulePoll(
                        nextPollDelayMs(
                            status = outcome.status,
                            retryAfterSeconds = outcome.retryAfterSeconds,
                            consecutiveThrottles = consecutiveThrottles,
                        ),
                    )
                }
            }, delayMs)
        } catch (e: IllegalStateException) {
            // Timer was cancelled between the null-check and the schedule.
            logger.debug("[pairing] poll timer already cancelled: ${e.message}")
        }
    }

    /** One poll's outcome, or null once pairing completed (loop stopped). */
    private data class PollOutcome(
        val status: Int,
        val retryAfterSeconds: Int?,
        val throttled: Boolean,
    )

    private fun checkPairingStatus(): PollOutcome? {
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
            val status = response.code
            // `Retry-After` is what the backend's throttler sends with a 429.
            // Ignoring it is exactly how this loop turned into a request flood.
            val retryAfterSeconds = response.header("Retry-After")?.trim()?.toIntOrNull()
            val throttled = status == 429 || status >= 500
            if (throttled) {
                response.close()
                logger.debug("[pairing] status poll throttled ($status) — backing off")
                return PollOutcome(status, retryAfterSeconds, throttled = true)
            }
            val body = response.body?.string()
                ?: return PollOutcome(status, retryAfterSeconds, throttled = false)

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
                        // "session expired" notification gate for the next failure,
                        // and un-latch the output publisher (a fresh pairing
                        // supersedes the dead one it latched on).
                        CommandRelayService.getInstance().resetAuthFailureGate()
                        AgentOutputPublisher.resetPairingLatch()
                    }
                    currentSessionId = sessionId
                    logger.info("Pairing detected! Session: $sessionId, user: ${pairedUser?.email}")
                    stopPolling()
                    saveCurrentSession()
                    listeners.forEach { it.onPaired(sessionId) }
                    return null
                }
            }
            return PollOutcome(status, retryAfterSeconds, throttled = false)
        } catch (e: Exception) {
            // Transport failure (no HTTP response): status 0 → treated as
            // throttle-worthy so a dead network doesn't spin at full speed.
            logger.debug("Polling error: ${e.message}")
            return PollOutcome(status = 0, retryAfterSeconds = null, throttled = true)
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
        /** How long one pairing attempt keeps polling before giving up. */
        private const val POLL_WINDOW_MS = 300_000L

        fun getInstance(): PairingService =
            ApplicationManager.getApplication().getService(PairingService::class.java)
    }
}
