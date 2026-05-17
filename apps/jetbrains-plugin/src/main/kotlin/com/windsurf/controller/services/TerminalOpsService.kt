package com.windsurf.controller.services

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.ProjectManager
import com.pty4j.PtyProcess
import com.pty4j.PtyProcessBuilder
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * PTY-backed terminal session manager for the JetBrains plugin.
 * Mirrors the cli + vsc-plugin implementations at the wire level
 * so the IDE's TerminalProvider sees identical chunks regardless
 * of which client is paired.
 *
 * Powered by pty4j — the same library IntelliJ uses internally
 * for its integrated terminal, so we get cross-platform PTY
 * support (Unix `forkpty`, Windows ConPTY/winpty) for free.
 */
@Service(Service.Level.APP)
class TerminalOpsService {

    private data class Session(
        val id: String,
        val hostSessionId: String,
        val process: PtyProcess,
        val reader: Thread,
    )

    private val sessions = ConcurrentHashMap<String, Session>()
    private val log = Logger.getInstance(TerminalOpsService::class.java)

    /**
     * Open a new shell. `hostSessionId` is the paired CodeAgent
     * session id (different from the PTY id we return) — needed
     * so data chunks route to the right per-session SSE stream.
     */
    fun open(hostSessionId: String, cols: Int, rows: Int, cwd: String?): JsonObject {
        val out = JsonObject()
        if (sessions.size >= MAX_CONCURRENT_SESSIONS) {
            out.addProperty("error", "Too many open terminals (max $MAX_CONCURRENT_SESSIONS)")
            return out
        }
        val effectiveCwd = cwd?.let { File(it) }?.takeIf { it.exists() && it.isDirectory }
            ?: projectRoot() ?: File(System.getProperty("user.home"))
        val shell = defaultShell()
        val env = HashMap(System.getenv())
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["FORCE_COLOR"] = "1"

        try {
            val process = PtyProcessBuilder(arrayOf(shell))
                .setDirectory(effectiveCwd.absolutePath)
                .setEnvironment(env)
                .setInitialColumns(cols.coerceIn(1, 500))
                .setInitialRows(rows.coerceIn(1, 200))
                .setConsole(false)
                .start()
            val id = UUID.randomUUID().toString()

            val reader = thread(name = "codeam-terminal-$id", isDaemon = true) {
                val buf = ByteArray(8192)
                try {
                    while (true) {
                        val n = process.inputStream.read(buf)
                        if (n < 0) break
                        val chunk = String(buf, 0, n, Charsets.UTF_8)
                        pushData(hostSessionId, id, chunk)
                    }
                } catch (t: Throwable) {
                    log.info("terminal reader stopped: ${t.message}")
                } finally {
                    val exit = try {
                        process.waitFor()
                    } catch (_: Throwable) {
                        0
                    }
                    pushExit(hostSessionId, id, exit)
                    sessions.remove(id)
                }
            }

            sessions[id] = Session(id, hostSessionId, process, reader)
            out.addProperty("sessionId", id)
            return out
        } catch (e: Exception) {
            out.addProperty("error", e.message ?: "spawn failed")
            return out
        }
    }

    fun write(sessionId: String, data: String): JsonObject {
        val out = JsonObject()
        val s = sessions[sessionId]
        if (s == null) {
            out.addProperty("ok", false)
            out.addProperty("error", "No such session")
            return out
        }
        return try {
            s.process.outputStream.write(data.toByteArray(Charsets.UTF_8))
            s.process.outputStream.flush()
            out.addProperty("ok", true)
            out
        } catch (e: Exception) {
            out.addProperty("ok", false)
            out.addProperty("error", e.message ?: "write failed")
            out
        }
    }

    fun resize(sessionId: String, cols: Int, rows: Int): JsonObject {
        val out = JsonObject()
        val s = sessions[sessionId]
        if (s == null) {
            out.addProperty("ok", false)
            out.addProperty("error", "No such session")
            return out
        }
        return try {
            s.process.setWinSize(com.pty4j.WinSize(cols.coerceIn(1, 500), rows.coerceIn(1, 200)))
            out.addProperty("ok", true)
            out
        } catch (e: Exception) {
            out.addProperty("ok", false)
            out.addProperty("error", e.message ?: "resize failed")
            out
        }
    }

    fun close(sessionId: String): JsonObject {
        val s = sessions.remove(sessionId)
        val out = JsonObject()
        out.addProperty("ok", true)
        if (s == null) return out
        try {
            s.process.destroy()
        } catch (_: Throwable) { /* already dead */ }
        return out
    }

    fun closeAll() {
        for (id in sessions.keys().toList()) close(id)
    }

    private fun defaultShell(): String {
        val os = System.getProperty("os.name").orEmpty().lowercase()
        return if (os.contains("win")) {
            System.getenv("COMSPEC") ?: "powershell.exe"
        } else {
            System.getenv("SHELL") ?: "/bin/bash"
        }
    }

    private fun projectRoot(): File? {
        val proj = ProjectManager.getInstance().openProjects.firstOrNull() ?: return null
        return proj.basePath?.let { File(it).canonicalFile }
    }

    /**
     * Push a chunk via the same /api/commands/output endpoint chat
     * uses. We don't share a `ChunkEmitterService` with the rest of
     * the plugin because the existing emitter (`AgentOutputMonitor`)
     * is wired into the agent-text streaming lifecycle; terminal
     * chunks are independent. The IDE client filters by
     * `terminalSessionId` to demux multiple concurrent terminals.
     */
    private fun pushData(hostSessionId: String, terminalSessionId: String, data: String) {
        val payload = JsonObject()
        payload.addProperty("type", "terminal_data")
        payload.addProperty("terminalSessionId", terminalSessionId)
        payload.addProperty("data", data)
        payload.addProperty("done", false)
        postChunk(hostSessionId, payload)
    }

    private fun pushExit(hostSessionId: String, terminalSessionId: String, exitCode: Int) {
        val payload = JsonObject()
        payload.addProperty("type", "terminal_exit")
        payload.addProperty("terminalSessionId", terminalSessionId)
        payload.addProperty("exitCode", exitCode)
        payload.addProperty("done", true)
        postChunk(hostSessionId, payload)
    }

    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()
    private val gson = Gson()

    private fun postChunk(hostSessionId: String, payload: JsonObject) {
        val settings = SettingsService.getInstance()
        val pluginId = settings.ensurePluginId()
        payload.addProperty("sessionId", hostSessionId)
        payload.addProperty("pluginId", pluginId)
        Thread {
            try {
                val builder = Request.Builder()
                    .url("${settings.state.apiBaseUrl}/api/commands/output")
                    .post(gson.toJson(payload).toRequestBody("application/json".toMediaType()))
                val token = settings.state.pluginAuthToken
                if (token.isNotBlank()) builder.addHeader("X-Plugin-Auth-Token", token)
                httpClient.newCall(builder.build()).execute().close()
            } catch (e: Exception) {
                log.debug("terminal chunk push failed: ${e.message}")
            }
        }.start()
    }

    companion object {
        private const val MAX_CONCURRENT_SESSIONS = 4

        fun getInstance(): TerminalOpsService =
            ApplicationManager.getApplication().getService(TerminalOpsService::class.java)
    }
}
