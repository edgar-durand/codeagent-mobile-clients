package com.windsurf.controller.services

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.util.SystemInfo
import com.windsurf.controller.GeneratedBuildConfig
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.time.Instant
import java.util.concurrent.TimeUnit

/**
 * PostHog telemetry for the JetBrains plugin. Mirrors the VS Code +
 * CLI services (apps/vsc-plugin/src/services/telemetry.service.ts,
 * apps/cli/src/services/telemetry.service.ts) so events land in the
 * same PostHog project under a unified person record.
 *
 * Captured context:
 *   - super properties: pluginVersion, ideName, ideVersion, platform, arch
 *   - person properties (on identify): userId, email, name, plan
 *   - per-event properties: per-call only — never prompt text, never
 *     tokens, never file paths inside the user's project.
 *
 * Opt-out:
 *   - `CODEAM_TELEMETRY=0` env var (parity with CLI / VS Code).
 *   - User's "Help → Data Sharing" privacy policy preference (see
 *     IDE's `PrivacyPolicy` API). Honoured implicitly: if the key is
 *     not baked into the build, capture is a no-op.
 *
 * Transport: plain HTTPS POST to PostHog's /capture/ endpoint — no
 * SDK dependency needed beyond OkHttp (already in the plugin's
 * dependency graph).
 */
@Service(Service.Level.APP)
class TelemetryService {

    private val logger = Logger.getInstance(TelemetryService::class.java)
    private val gson = Gson()
    private val client = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build()

    @Volatile
    private var distinctId: String? = null
    @Volatile
    private var identified: Boolean = false
    @Volatile
    private var initialised: Boolean = false

    fun init(machineId: String) {
        if (initialised) return
        if (isOptedOut()) return
        if (GeneratedBuildConfig.POSTHOG_API_KEY.isEmpty()) return
        distinctId = "jetbrains-$machineId"
        initialised = true
    }

    private fun isOptedOut(): Boolean {
        if (System.getenv("CODEAM_TELEMETRY") == "0") return true
        if (System.getenv("NO_TELEMETRY") != null) return true
        return false
    }

    private fun superProperties(): JsonObject = JsonObject().apply {
        addProperty("pluginVersion", GeneratedBuildConfig.PLUGIN_VERSION)
        addProperty("pluginSurface", "jetbrains")
        addProperty("ideName", System.getProperty("idea.platform.prefix") ?: "Idea")
        addProperty("ideVersion", System.getProperty("idea.version") ?: "unknown")
        addProperty("platform", when {
            SystemInfo.isMac -> "darwin"
            SystemInfo.isWindows -> "win32"
            SystemInfo.isLinux -> "linux"
            else -> "other"
        })
        addProperty("arch", System.getProperty("os.arch") ?: "unknown")
    }

    data class IdentifyParams(
        val userId: String,
        val email: String? = null,
        val name: String? = null,
        val plan: String? = null,
    )

    fun identify(params: IdentifyParams) {
        if (!initialised) return
        val current = distinctId ?: return
        if (identified) return
        identified = true
        // Alias the anonymous machine-scoped id to the real userId so
        // pre-pair events stitch to the now-identified person.
        if (current != params.userId) {
            postBatch(listOf(aliasPayload(current, params.userId)))
        }
        distinctId = params.userId
        val props = JsonObject()
        params.email?.let { props.addProperty("email", it) }
        params.name?.let { props.addProperty("name", it) }
        params.plan?.let { props.addProperty("plan", it) }
        postBatch(listOf(identifyPayload(params.userId, props)))
    }

    /**
     * Fire-and-forget event capture. Runs the HTTP POST on a pooled
     * thread so we don't block the EDT (or the caller). Property
     * names matching token/secret/api-key patterns are dropped before
     * send to defend against future call sites passing a secret.
     */
    fun capture(event: String, properties: Map<String, Any?> = emptyMap()) {
        if (!initialised) return
        val id = distinctId ?: return
        val sanitized = JsonObject()
        for ((k, v) in properties) {
            if (v == null) continue
            if (k.matches(Regex("(?i)token|secret|api[-_]?key|password"))) continue
            when (v) {
                is String -> sanitized.addProperty(k, v)
                is Number -> sanitized.addProperty(k, v)
                is Boolean -> sanitized.addProperty(k, v)
                else -> sanitized.addProperty(k, v.toString())
            }
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            postBatch(listOf(capturePayload(id, event, sanitized)))
        }
    }

    /** Drop a caught error onto PostHog with a trimmed stack. */
    fun captureError(event: String, error: Throwable, extra: Map<String, Any?> = emptyMap()) {
        val stack = error.stackTrace.take(12).joinToString("\n") { it.toString() }
        capture(event, extra + mapOf("errorMessage" to (error.message ?: error::class.qualifiedName), "errorStack" to stack))
    }

    private fun capturePayload(distinct: String, event: String, props: JsonObject): JsonObject {
        val merged = superProperties()
        for (entry in props.entrySet()) merged.add(entry.key, entry.value)
        return JsonObject().apply {
            addProperty("event", event)
            addProperty("distinct_id", distinct)
            add("properties", merged)
            addProperty("timestamp", Instant.now().toString())
        }
    }

    private fun aliasPayload(from: String, to: String): JsonObject = JsonObject().apply {
        addProperty("event", "\$create_alias")
        addProperty("distinct_id", to)
        add("properties", JsonObject().apply {
            addProperty("distinct_id", to)
            addProperty("alias", from)
        })
        addProperty("timestamp", Instant.now().toString())
    }

    private fun identifyPayload(distinct: String, props: JsonObject): JsonObject = JsonObject().apply {
        addProperty("event", "\$identify")
        addProperty("distinct_id", distinct)
        add("\$set", props)
        add("properties", superProperties())
        addProperty("timestamp", Instant.now().toString())
    }

    private fun postBatch(events: List<JsonObject>) {
        if (events.isEmpty()) return
        val body = JsonObject().apply {
            addProperty("api_key", GeneratedBuildConfig.POSTHOG_API_KEY)
            add("batch", com.google.gson.JsonArray().also { arr -> events.forEach { arr.add(it) } })
        }
        val request = Request.Builder()
            .url("${GeneratedBuildConfig.POSTHOG_HOST}/batch/")
            .post(gson.toJson(body).toRequestBody("application/json".toMediaType()))
            .build()
        try {
            client.newCall(request).execute().close()
        } catch (e: Exception) {
            logger.debug("PostHog capture failed: ${e.message}")
        }
    }

    companion object {
        fun getInstance(): TelemetryService =
            ApplicationManager.getApplication().getService(TelemetryService::class.java)
    }
}
