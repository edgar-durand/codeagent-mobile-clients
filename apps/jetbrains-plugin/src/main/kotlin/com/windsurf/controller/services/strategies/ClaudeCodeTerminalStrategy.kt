package com.windsurf.controller.services.strategies

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.windsurf.controller.services.DetectedAgent
import com.windsurf.controller.services.PairingService
import com.windsurf.controller.services.SettingsService
import com.windsurf.controller.services.TerminalAgentService
import java.io.BufferedWriter
import java.io.File
import java.io.OutputStreamWriter
import java.util.concurrent.TimeUnit

/**
 * Claude Code, driven through `codeam-cli` running as a subprocess of
 * the plugin. The plugin keeps owning the single PairedSession; the
 * subprocess just borrows the session's auth creds (passed via env)
 * and uses them to push the chunks Claude's PTY produces. **No new
 * session is created** — mobile sees the same session it always did,
 * but every Claude Code response now flows through the CLI's parser
 * (selectors, thinking panels, pricing, history sync) instead of the
 * plugin's terminal-buffer scrape.
 *
 * The plugin host is the polling client. When a `start_task` (or any
 * other command) for Claude Code lands, the strategy:
 *
 *   1. Lazily ensures `codeam` is on PATH at the minimum required
 *      version (auto-installs / upgrades via the user's login shell
 *      if missing). Falls back to the legacy terminal-scrape flow if
 *      the bridge can't be brought up.
 *   2. Spawns `codeam plugin-bridge` once per IDE session, holds the
 *      Process handle, and writes each command as one line of JSON
 *      to its stdin.
 *
 * The legacy `TerminalAgentService` flow stays as the safety net: if
 * the bridge can't be set up (no codeam, no npm, network failure,
 * crash mid-session), the user still gets a working Claude Code via
 * the in-IDE terminal — just without the richer chunk pipeline.
 */
class ClaudeCodeTerminalStrategy : AgentStrategy {
    override val name: String = "Claude Code (cli-bridge)"
    private val logger = Logger.getInstance(ClaudeCodeTerminalStrategy::class.java)
    private val gson = Gson()

    @Volatile private var bridge: BridgeProcess? = null

    override fun canHandle(agent: DetectedAgent?): Boolean {
        if (agent == null) return false
        if (agent.toolWindowId.startsWith("__terminal__:claude_code")) return true
        if (agent.pluginId.contains("anthropic", ignoreCase = true)) return true
        if (agent.pluginId.contains("claude", ignoreCase = true)) return true
        return agent.name.contains("Claude Code", ignoreCase = true)
    }

    override fun execute(invocation: AgentInvocation): Boolean {
        val current = ensureBridge(invocation.project)
        if (current != null) {
            // Bridge is up — forward the original `start_task` to it.
            // The CLI handles attachments, history, output streaming,
            // everything. Plugin's job is to write the line and forget.
            val cmd = JsonObject().apply {
                addProperty("id", invocation.sessionId + ":" + System.nanoTime())
                addProperty("type", "start_task")
                add("payload", JsonObject().apply { addProperty("prompt", invocation.prompt) })
            }
            return current.writeLine(gson.toJson(cmd))
        }

        // Bridge unavailable — fall back to the original terminal scrape.
        logger.warn("plugin-bridge unavailable; falling back to terminal scrape for Claude Code")
        return fallbackTerminalScrape(invocation)
    }

    override fun stop() {
        // Stop both the bridge and any legacy monitor: whichever was in
        // play, the user wants Claude Code halted.
        bridge?.let { proc ->
            try {
                proc.writeLine(gson.toJson(JsonObject().apply {
                    addProperty("id", "stop:" + System.nanoTime())
                    addProperty("type", "stop_task")
                    add("payload", JsonObject())
                }))
            } catch (_: Exception) { /* ignore */ }
        }
        TerminalAgentService.getInstance().stopMonitoring()
    }

    /* ─────────────────────── Fallback ─────────────────────── */

    private fun fallbackTerminalScrape(invocation: AgentInvocation): Boolean {
        val configId = invocation.agent?.toolWindowId?.removePrefix("__terminal__:")
            ?: "claude_code"
        val config = TerminalAgentService.TERMINAL_AGENTS.find { it.id == configId }
            ?: TerminalAgentService.TERMINAL_AGENTS.first()
        val terminal = TerminalAgentService.getInstance()
        terminal.setProject(invocation.project)
        val sent = terminal.sendPromptToTerminalAgent(invocation.prompt, config)
        if (!sent) return false
        terminal.startMonitoring(invocation.sessionId, invocation.prompt)
        return true
    }

    /* ─────────────────────── Bridge lifecycle ─────────────────────── */

    /**
     * Returns a live bridge process, spawning one on first use. Returns
     * null if codeam couldn't be made available or the plugin's auth
     * creds aren't ready yet (e.g. the user just paired with a CLI
     * version that didn't persist `pluginAuthToken` and hasn't hit
     * Reconnect yet).
     */
    @Synchronized
    private fun ensureBridge(project: Project): BridgeProcess? {
        bridge?.let {
            if (it.isAlive()) return it
            logger.info("plugin-bridge process exited (rc=${it.exitCode()}); will respawn")
            bridge = null
        }
        if (!ensureCodeamOnPath()) return null
        val pairing = PairingService.getInstance()
        val sessionId = pairing.currentSessionId
        if (sessionId.isNullOrBlank()) {
            logger.warn("plugin-bridge: no active sessionId yet")
            return null
        }
        val settings = SettingsService.getInstance()
        val pluginId = settings.ensurePluginId()
        val pluginAuthToken = settings.state.pluginAuthToken
        if (pluginAuthToken.isBlank()) {
            logger.warn("plugin-bridge: pluginAuthToken missing — try Reconnect from sidebar")
            return null
        }

        return try {
            val isWin = System.getProperty("os.name").lowercase().contains("win")
            val argv = if (isWin) {
                listOf("cmd", "/c", "codeam plugin-bridge")
            } else {
                listOf(userShell(), "-l", "-c", "codeam plugin-bridge")
            }
            val pb = ProcessBuilder(argv)
            pb.environment()["CODEAM_BRIDGE_SESSION_ID"] = sessionId
            pb.environment()["CODEAM_BRIDGE_PLUGIN_ID"] = pluginId
            pb.environment()["CODEAM_BRIDGE_PLUGIN_AUTH_TOKEN"] = pluginAuthToken
            pb.environment()["CODEAM_API_URL"] = settings.state.apiBaseUrl
            // Bridge runs locally; never let an inherited CODESPACE_NAME
            // mislead any downstream codespace-only code paths.
            pb.environment().remove("CODESPACE_NAME")
            project.basePath?.let { pb.directory(File(it)) }
            // We pipe stdin/stdout/stderr instead of inheriting them
            // so the IDE's I/O isn't tangled with the subprocess and
            // we can write commands one line at a time.
            pb.redirectErrorStream(true)
            val process = pb.start()
            // Drain stdout into the IDE log so failures inside the
            // bridge surface as something diagnosable instead of dead
            // silence. Daemon thread so it doesn't keep the IDE alive.
            Thread({
                try {
                    process.inputStream.bufferedReader().forEachLine { line ->
                        if (line.isNotBlank()) logger.info("[plugin-bridge] $line")
                    }
                } catch (_: Exception) { /* process closed */ }
            }, "plugin-bridge-reader").apply { isDaemon = true; start() }
            val writer = BufferedWriter(OutputStreamWriter(process.outputStream, Charsets.UTF_8))
            val handle = BridgeProcess(process, writer)
            bridge = handle
            logger.info("Spawned codeam plugin-bridge (pid=${process.pid()})")
            handle
        } catch (e: Exception) {
            logger.warn("Could not spawn codeam plugin-bridge: ${e.message}")
            null
        }
    }

    /* ─────────────────────── codeam install/upgrade ─────────────────────── */

    private fun ensureCodeamOnPath(): Boolean {
        val current = currentCodeamVersion()
        if (current != null && versionAtLeast(current, MIN_MAJOR, MIN_MINOR, MIN_PATCH)) {
            return true
        }
        if (current != null) {
            logger.info("codeam-cli $current below minimum $MIN_MAJOR.$MIN_MINOR.$MIN_PATCH — upgrading")
        } else {
            logger.info("codeam-cli not on PATH — installing")
        }
        if (runInLoginShell("command -v npm")?.first != 0) {
            logger.warn("npm not callable from login shell — skipping install/upgrade")
            return false
        }
        val (code, output) = runInLoginShell("npm i -g codeam-cli@latest", timeoutSeconds = 180)
            ?: return false
        if (code != 0) {
            logger.warn("codeam-cli install/upgrade exited $code: ${output.take(500)}")
            return false
        }
        val newVersion = currentCodeamVersion()
        if (newVersion != null && versionAtLeast(newVersion, MIN_MAJOR, MIN_MINOR, MIN_PATCH)) {
            logger.info("codeam-cli now at $newVersion")
            return true
        }
        logger.warn("codeam-cli post-install version check failed: got '$newVersion'")
        return false
    }

    private fun currentCodeamVersion(): String? {
        val (code, output) = runInLoginShell("codeam --version") ?: return null
        if (code != 0) return null
        return Regex("""(\d+\.\d+\.\d+)""").find(output)?.value
    }

    private fun versionAtLeast(version: String, major: Int, minor: Int, patch: Int): Boolean {
        val parts = version.split(".").mapNotNull { it.toIntOrNull() }
        if (parts.size < 3) return false
        val (a, b, c) = Triple(parts[0], parts[1], parts[2])
        if (a != major) return a > major
        if (b != minor) return b > minor
        return c >= patch
    }

    private fun runInLoginShell(command: String, timeoutSeconds: Long = 30): Pair<Int, String>? {
        val isWin = System.getProperty("os.name").lowercase().contains("win")
        val argv: List<String> = if (isWin) {
            listOf("cmd", "/c", command)
        } else {
            listOf(userShell(), "-l", "-c", command)
        }
        return try {
            val process = ProcessBuilder(argv).redirectErrorStream(true).start()
            val finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS)
            if (!finished) {
                process.destroyForcibly()
                return null
            }
            val out = process.inputStream.bufferedReader().readText().trim()
            process.exitValue() to out
        } catch (_: Exception) {
            null
        }
    }

    private fun userShell(): String =
        System.getenv("SHELL")
            ?: if (System.getProperty("os.name").lowercase().contains("mac")) "/bin/zsh" else "/bin/bash"

    companion object {
        // Minimum CLI version that ships `plugin-bridge`.
        private const val MIN_MAJOR = 2
        private const val MIN_MINOR = 8
        private const val MIN_PATCH = 0
    }

    /**
     * Holds a live bridge subprocess + its stdin writer. Synchronizes
     * `writeLine` so two concurrent `start_task` commands can't
     * interleave half-encoded JSON on the wire.
     */
    private class BridgeProcess(
        private val process: Process,
        private val writer: BufferedWriter,
    ) {
        @Synchronized
        fun writeLine(json: String): Boolean = try {
            writer.write(json)
            writer.newLine()
            writer.flush()
            true
        } catch (_: Exception) {
            false
        }

        fun isAlive(): Boolean = process.isAlive
        fun exitCode(): Int = if (process.isAlive) -1 else process.exitValue()
    }
}
