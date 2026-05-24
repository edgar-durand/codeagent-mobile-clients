package com.windsurf.controller.services

import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.openapi.diagnostic.Logger
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * Wire publisher for TerminalAgentService's polling loop. Owns the
 * outbound chunk shapes that flow to /api/commands/output and
 * /api/sessions/claude-conversation:
 *
 *   - pushOutput(text/chrome/status/…)
 *   - pushChromeSteps  → `chrome_steps` chunk with delta steps
 *   - pushConversationDelta → 2-message append to claude-conversation
 *   - pushSelectPrompt → `select_prompt` chunk with options
 *   - clearRemoteOutput → canonical `type:"clear"` chunk
 *
 * Method calls are SYNCHRONOUS on the calling thread (typically the
 * `terminal-output-monitor` daemon Timer thread that runs the poll
 * loop). The synchronous shape preserves chunk-ordering inside a
 * single poll tick — a `text done:true` chunk emitted after several
 * intermediate `text done:false` chunks must land in that order so
 * the mobile renderer doesn't see "complete" before the body
 * finished streaming.
 *
 * Mirrors the simpler AgentOutputPublisher in the same package — that
 * one is fire-and-forget for the JCEF/Swing scraper. TerminalAgent's
 * polling tick is ordered enough to deserve its own synchronous
 * shape.
 */
internal object TerminalOutputPublisher {

    private val logger = Logger.getInstance(TerminalOutputPublisher::class.java)
    private val gson = Gson()
    private val client = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build()

    fun pushOutput(sessionId: String, type: String, content: String, done: Boolean) {
        val settings = SettingsService.getInstance()
        val pluginId = settings.ensurePluginId()
        val body = JsonObject().apply {
            addProperty("sessionId", sessionId)
            addProperty("pluginId", pluginId)
            addProperty("type", type)
            addProperty("content", content)
            addProperty("done", done)
        }
        post("${settings.state.apiBaseUrl}/api/commands/output", body, "terminal $type done=$done length=${content.length}")
    }

    /**
     * Ship a `chrome_steps` chunk with only the delta steps. Mobile /
     * web append these to the active agent message's thinking
     * timeline (read/edit/bash/search/…).
     */
    fun pushChromeSteps(sessionId: String, steps: List<ChromeStep>) {
        if (steps.isEmpty()) return
        val settings = SettingsService.getInstance()
        val pluginId = settings.ensurePluginId()
        val arr = JsonArray()
        for (s in steps) {
            arr.add(JsonObject().apply {
                addProperty("tool", s.tool)
                addProperty("label", s.label)
                val detail = s.detail
                if (detail != null) addProperty("detail", detail)
                addProperty("status", s.status)
            })
        }
        val body = JsonObject().apply {
            addProperty("sessionId", sessionId)
            addProperty("pluginId", pluginId)
            addProperty("type", "chrome_steps")
            add("appendSteps", arr)
        }
        post("${settings.state.apiBaseUrl}/api/commands/output", body, "${steps.size} chrome step(s)")
    }

    /**
     * Push the turn's user prompt + agent response as a 2-message
     * delta to /api/sessions/claude-conversation with mode:"append".
     * Server merges by `id` so a retry of the same turn is a no-op.
     */
    fun pushConversationDelta(sessionId: String, userPrompt: String, agentResponse: String) {
        if (userPrompt.isBlank() && agentResponse.isBlank()) return
        val settings = SettingsService.getInstance()
        val pluginId = settings.ensurePluginId()
        val now = System.currentTimeMillis()
        val msgs = JsonArray()
        if (userPrompt.isNotBlank()) {
            msgs.add(JsonObject().apply {
                addProperty("id", "jb-${now}-u")
                addProperty("role", "user")
                addProperty("text", userPrompt)
                addProperty("timestamp", now)
            })
        }
        if (agentResponse.isNotBlank()) {
            msgs.add(JsonObject().apply {
                addProperty("id", "jb-${now}-a")
                addProperty("role", "agent")
                addProperty("text", agentResponse)
                addProperty("timestamp", now + 1)
            })
        }
        val body = JsonObject().apply {
            addProperty("pluginId", pluginId)
            addProperty("sessionId", sessionId)
            addProperty("mode", "append")
            add("messages", msgs)
        }
        post("${settings.state.apiBaseUrl}/api/sessions/claude-conversation", body, "conversation delta ${msgs.size()} msg(s)")
    }

    fun pushSelectPrompt(sessionId: String, prompt: SelectPrompt) {
        val settings = SettingsService.getInstance()
        val pluginId = settings.ensurePluginId()
        val optsArr = JsonArray().apply { prompt.options.forEach { add(it) } }
        val descsArr = JsonArray().apply { prompt.optionDescriptions.forEach { add(it) } }
        val body = JsonObject().apply {
            addProperty("sessionId", sessionId)
            addProperty("pluginId", pluginId)
            addProperty("type", "select_prompt")
            addProperty("content", prompt.question)
            add("options", optsArr)
            add("optionDescriptions", descsArr)
            addProperty("currentIndex", prompt.currentIndex)
        }
        post("${settings.state.apiBaseUrl}/api/commands/output", body, "select_prompt ${prompt.options.size} opts")
    }

    fun clearRemoteOutput(sessionId: String) {
        // Canonical CLI shape — POST with `type:"clear"`. The
        // pre-#83 field name was `clear:true`, which the backend
        // accepted incidentally but isn't the documented protocol.
        val settings = SettingsService.getInstance()
        val pluginId = settings.ensurePluginId()
        val body = JsonObject().apply {
            addProperty("sessionId", sessionId)
            addProperty("pluginId", pluginId)
            addProperty("type", "clear")
        }
        post("${settings.state.apiBaseUrl}/api/commands/output", body, "clear")
    }

    private fun post(url: String, body: JsonObject, summary: String) {
        val request = Request.Builder()
            .url(url)
            .post(gson.toJson(body).toRequestBody("application/json".toMediaType()))
            .withAuthHeaders()
            .build()
        try {
            client.newCall(request).execute().close()
            logger.info("Pushed: $summary")
        } catch (e: Exception) {
            logger.warn("Failed to push ($summary): ${e.message}")
        }
    }
}
