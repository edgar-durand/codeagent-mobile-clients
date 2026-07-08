package com.windsurf.controller.ui

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.notification.Notification
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.notification.Notifications
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindowManager
import com.windsurf.controller.protocol.CLI_FALLBACK_DEFAULT_MODEL_ID
import com.windsurf.controller.protocol.CLI_FALLBACK_MODELS
import com.windsurf.controller.services.AgentOutputMonitor
import com.windsurf.controller.services.CommandRelayService
import com.windsurf.controller.services.FileOpsService
import com.windsurf.controller.services.IdeIntegrationService
import com.windsurf.controller.services.McpConfigWriterService
import com.windsurf.controller.services.McpConfigureRequest
import com.windsurf.controller.services.McpEntry
import com.windsurf.controller.services.McpServerDef
import com.windsurf.controller.services.PairingService
import com.windsurf.controller.services.ProjectOpsService
import com.windsurf.controller.services.SettingsService
import com.windsurf.controller.services.TerminalOpsService
import com.windsurf.controller.services.strategies.AgentInvocation
import com.windsurf.controller.services.strategies.AgentStrategyRegistry
import com.windsurf.controller.services.strategies.CopilotChatMetadataBridge
import com.windsurf.controller.util.BuildInstallCommand
import com.windsurf.controller.util.CliAgentId
import org.jetbrains.plugins.terminal.TerminalToolWindowManager
import java.awt.Toolkit
import java.awt.datatransfer.StringSelection
import javax.swing.SwingUtilities

/**
 * Routes a single RemoteCommand to the right service. Extracted from
 * the giant `ControllerToolWindowFactory.ControllerPanel.onCommandReceived`
 * switch so the tool-window class can stay focused on layout +
 * lifecycle instead of carrying ~620 lines of dispatch logic.
 *
 * The router owns only `project` (for terminal operations + file ops
 * that need a workspace root) and `logger` for diagnostics. Everything
 * else flows through the existing application-scoped services.
 *
 * Mirrors `apps/vsc-plugin/src/panels/remote-command-router.ts` — the
 * two clients keep the same dispatch shape so a new command lands in
 * one focused file per plugin instead of a giant inner class.
 */
class RemoteCommandRouter(private val project: Project) {

    private val logger = Logger.getInstance(RemoteCommandRouter::class.java)

    /**
     * Thrown inside a [respondWith] block to fail the command with a
     * specific error message. When the legacy wire shape sent a richer
     * object than `{error}` on failure (e.g. terminal_write's
     * `{ok:false,…}`), carry it via [payload] so the mobile client
     * keeps seeing the exact same body.
     */
    private class CommandFailed(
        message: String,
        val payload: JsonObject? = null,
    ) : Exception(message)

    /**
     * Runs a command arm's work and guarantees EXACTLY ONE sendResult:
     * "completed" with the produced payload on success, "failed" with
     * `{error: message}` (or the payload carried by [CommandFailed])
     * when the block throws. Kotlin twin of the VS Code router's
     * `respondWith` (apps/vsc-plugin/src/panels/remote-command-router.ts).
     * Before this, an arm that threw before its own sendResult left the
     * command without a terminal result — the mobile side hung until
     * its timeout.
     */
    private fun respondWith(
        command: CommandRelayService.RemoteCommand,
        relay: CommandRelayService,
        produce: () -> JsonObject,
    ) {
        val payload = try {
            produce()
        } catch (e: Exception) {
            logger.warn("[${command.type}] handler failed: ${e.message}")
            val failure = (e as? CommandFailed)?.payload
                ?: JsonObject().apply { addProperty("error", e.message ?: e.toString()) }
            relay.sendResult(command.id, "failed", failure)
            return
        }
        relay.sendResult(command.id, "completed", payload)
    }

    fun dispatch(command: CommandRelayService.RemoteCommand) {
        SwingUtilities.invokeLater {
            val relay = CommandRelayService.getInstance()
            val ide = IdeIntegrationService.getInstance()

            when (command.type) {
                // VS Code aliases `send_prompt` to `start_task`
                // (controller-panel.ts) — match the alias here so
                // mobile-side senders that use either name dispatch
                // identically. The handler body falls through to the
                // start_task arm via type munging.
                "send_prompt", "start_task" -> respondWith(command, relay) {
                    var prompt = command.payload.get("prompt")?.asString ?: ""
                    val agentId = command.payload.get("agentId")?.asString

                    // The mobile/web model picker sends the change
                    // as a `start_task` whose prompt is `/model
                    // <id>` (the slash command Claude Code
                    // interprets). Copilot has no slash commands —
                    // it must go through `ChatAction.ModelSelected`
                    // via the metadata bridge. The frontend does
                    // NOT include `agentId` on that payload (only
                    // on get_context / list_models), so we can't
                    // gate on it here. Instead we check whether
                    // the requested modelId belongs to Copilot's
                    // catalog: if it does, switch via Copilot; if
                    // not, fall through to the normal strategy
                    // dispatch so `/model claude-sonnet-4-6` keeps
                    // working when the active agent is Claude.
                    val modelSwitch = Regex("^/model\\s+(\\S+)\\s*$").find(prompt.trim())
                    if (modelSwitch != null) {
                        val modelId = modelSwitch.groupValues[1]
                        // Try Copilot first; selectModel returns false
                        // immediately if Copilot isn't installed or
                        // the modelId doesn't match its catalog (by
                        // id / family / name — case + space
                        // tolerant). On false, fall through so
                        // `/model claude-sonnet-4-6` still reaches
                        // Claude Code's slash-command handler.
                        if (CopilotChatMetadataBridge.selectModel(project, modelId)) {
                            return@respondWith com.google.gson.JsonObject().apply {
                                addProperty("message", "Switched Copilot model to $modelId")
                                addProperty("modelId", modelId)
                                addProperty("applied", true)
                            }
                        }
                    }

                    // Inline @path attachments — mirror AgentBridgeService /
                    // CLI's saveFilesTemp. Files arrive as base64 in the
                    // payload; we materialize them to tmpdir and prefix the
                    // prompt with `@path` references that Claude Code reads.
                    // Schedule cleanup after 2 min so the prompt actually
                    // gets a chance to consume them.
                    val files = command.payload.getAsJsonArray("files")
                    if (files != null && files.size() > 0) {
                        // Cap each attachment at 10 MB to match the
                        // mobile composer + the VS Code plugin. A 50 MB
                        // base64 blob would stall the EDT on the decode
                        // + write and risk OOM on smaller heaps.
                        val maxAttachmentBytes = 10L * 1024L * 1024L
                        val refs = mutableListOf<String>()
                        val writtenPaths = mutableListOf<java.io.File>()
                        var oversized: String? = null
                        outer@ for (el in files) {
                            val f = el.asJsonObject
                            val filename = f.get("filename")?.asString ?: continue@outer
                            val base64 = f.get("base64")?.asString ?: continue@outer
                            val approxBytes = (base64.length.toLong() * 3L) / 4L
                            if (approxBytes > maxAttachmentBytes) {
                                oversized = "$filename ($approxBytes bytes > $maxAttachmentBytes)"
                                break@outer
                            }
                            val safeName = filename.replace(Regex("[^a-zA-Z0-9._-]"), "_").take(80)
                            val tmp = java.io.File(System.getProperty("java.io.tmpdir"), "codeagent-${System.currentTimeMillis()}-$safeName")
                            tmp.writeBytes(java.util.Base64.getDecoder().decode(base64))
                            writtenPaths.add(tmp)
                            refs.add("@${tmp.absolutePath}")
                            Thread {
                                try { Thread.sleep(120_000); tmp.delete() } catch (e: Exception) { logger.trace(e) }
                            }.start()
                        }
                        if (oversized != null) {
                            writtenPaths.forEach { runCatching { it.delete() } }
                            throw CommandFailed("Attachment too large: $oversized")
                        }
                        if (refs.isNotEmpty()) {
                            prompt = "${refs.joinToString(" ")} $prompt".trim()
                        }
                    }
                    logger.info("Command: start_task")
                    // Terminal-agent commands (Claude / Codex / Cursor /
                    // CodeRabbit / Aider) are owned by codeam-cli — the
                    // mobile should dispatch them to the CLI's pluginId,
                    // not the IDE plugin's. Reject explicitly so the
                    // user sees a clear hint instead of a silent observer
                    // no-op.
                    if (agentId != null && agentId.startsWith("__terminal__:")) {
                        throw CommandFailed("Terminal agents are run by codeam-cli. Install it (npm i -g codeam-cli) and run `codeam pair`.")
                    }
                    // Resolve the target agent up front so we can hand a
                    // typed `AgentInvocation` to the strategy registry.
                    // The registry then picks the right strategy based on
                    // toolWindowId / pluginId, sends the prompt and wires
                    // up the matching output monitor — everything that
                    // used to live as inline if/else here.
                    val targetAgent = if (agentId != null) {
                        ide.detectInstalledAgents().find { it.id == agentId }
                    } else {
                        ide.detectInstalledAgents().firstOrNull {
                            !it.toolWindowId.startsWith("__terminal__:")
                        } ?: ide.detectInstalledAgents().firstOrNull()
                    }
                    val sent = AgentStrategyRegistry.getInstance().execute(
                        AgentInvocation(
                            project = project,
                            agent = targetAgent,
                            prompt = prompt,
                            sessionId = command.sessionId,
                        )
                    )
                    com.google.gson.JsonObject().apply {
                        addProperty("message", if (sent) "Task started: $prompt" else "Could not deliver prompt — copied to clipboard")
                    }
                }
                "stop_task", "escape_key" -> respondWith(command, relay) {
                    AgentStrategyRegistry.getInstance().stop()
                    logger.info("Command: stop_task")
                    com.google.gson.JsonObject().apply {
                        addProperty("message", "Task stopped")
                    }
                }
                "approve_action" -> {
                    logger.info("Command: approve_action")
                    relay.sendResult(command.id, "completed", com.google.gson.JsonObject().apply {
                        addProperty("message", "Action approved")
                    })
                }
                "reject_action" -> {
                    logger.info("Command: reject_action")
                    relay.sendResult(command.id, "completed", com.google.gson.JsonObject().apply {
                        addProperty("message", "Action rejected")
                    })
                }
                "provide_input" -> respondWith(command, relay) {
                    val input = command.payload.get("input")?.asString ?: ""
                    logger.info("Command: provide_input (${input.take(50)}…)")
                    ide.sendPromptToIde(input)
                    com.google.gson.JsonObject().apply {
                        addProperty("message", "Input provided")
                    }
                }
                "mcp_configure" -> {
                    handleMcpConfigure(command, relay)
                }
                "mcp_status" -> {
                    handleMcpStatus(command, relay)
                }
                "read_file" -> respondWith(command, relay) {
                    val filePath = command.payload.get("path")?.asString
                    if (filePath.isNullOrEmpty()) throw CommandFailed("Missing path")
                    FileOpsService.getInstance().readFile(filePath)
                }
                "write_file" -> respondWith(command, relay) {
                    val filePath = command.payload.get("path")?.asString
                    val contentEl = command.payload.get("content")
                    if (filePath.isNullOrEmpty() || contentEl == null || contentEl.isJsonNull) {
                        throw CommandFailed("Missing path or content")
                    }
                    FileOpsService.getInstance().writeFile(filePath, contentEl.asString)
                }
                "list_files" -> respondWith(command, relay) {
                    val q = command.payload.get("query")?.asString
                    ProjectOpsService.getInstance().listFiles(q)
                }
                "search_files" -> respondWith(command, relay) {
                    val query = command.payload.get("query")?.asString
                    if (query.isNullOrBlank()) throw CommandFailed("Missing query")
                    val include = command.payload.getAsJsonArray("include")?.mapNotNull { it.asString }
                    val exclude = command.payload.getAsJsonArray("exclude")?.mapNotNull { it.asString }
                    val maxResults = command.payload.get("maxResults")?.asInt ?: 500
                    ProjectOpsService.getInstance().searchFiles(
                        query,
                        command.payload.get("caseSensitive")?.asBoolean ?: false,
                        command.payload.get("wholeWord")?.asBoolean ?: false,
                        command.payload.get("regex")?.asBoolean ?: false,
                        include,
                        exclude,
                        maxResults,
                    )
                }
                "terminal_open" -> respondWith(command, relay) {
                    val cols = command.payload.get("cols")?.asInt ?: 80
                    val rows = command.payload.get("rows")?.asInt ?: 24
                    val cwd = command.payload.get("cwd")?.asString
                    TerminalOpsService.getInstance().open(command.sessionId, cols, rows, cwd)
                }
                "terminal_write" -> respondWith(command, relay) {
                    val ts = command.payload.get("sessionId")?.asString
                    val data = command.payload.get("data")?.asString
                    if (ts.isNullOrBlank() || data == null) throw CommandFailed("Missing sessionId or data")
                    val r = TerminalOpsService.getInstance().write(ts, data)
                    if (r.get("ok")?.asBoolean != true) {
                        throw CommandFailed(r.get("error")?.asString ?: "terminal_write failed", r)
                    }
                    r
                }
                "terminal_resize" -> respondWith(command, relay) {
                    val ts = command.payload.get("sessionId")?.asString
                    val cols = command.payload.get("cols")?.asInt
                    val rows = command.payload.get("rows")?.asInt
                    if (ts.isNullOrBlank() || cols == null || rows == null) {
                        throw CommandFailed("Missing sessionId / cols / rows")
                    }
                    val r = TerminalOpsService.getInstance().resize(ts, cols, rows)
                    if (r.get("ok")?.asBoolean != true) {
                        throw CommandFailed(r.get("error")?.asString ?: "terminal_resize failed", r)
                    }
                    r
                }
                "terminal_close" -> respondWith(command, relay) {
                    val ts = command.payload.get("sessionId")?.asString
                    if (ts.isNullOrBlank()) throw CommandFailed("Missing sessionId")
                    TerminalOpsService.getInstance().close(ts)
                }
                "git_status" -> respondWith(command, relay) {
                    ProjectOpsService.getInstance().gitStatus()
                }
                "git_diff" -> respondWith(command, relay) {
                    val p = command.payload.get("path")?.asString
                    ProjectOpsService.getInstance().gitDiff(p)
                }
                "git_diff_staged" -> respondWith(command, relay) {
                    val p = command.payload.get("path")?.asString
                    ProjectOpsService.getInstance().gitDiffStaged(p)
                }
                "git_log" -> respondWith(command, relay) {
                    val limit = command.payload.get("limit")?.asInt ?: 30
                    ProjectOpsService.getInstance().gitLog(limit)
                }
                "git_commit" -> respondWith(command, relay) {
                    val message = command.payload.get("message")?.asString
                    if (message.isNullOrBlank()) throw CommandFailed("Missing message")
                    val pathsEl = command.payload.getAsJsonArray("paths")
                    val paths = pathsEl?.mapNotNull { it.asString }
                    ProjectOpsService.getInstance().gitCommit(message, paths)
                }
                "git_push" -> respondWith(command, relay) {
                    ProjectOpsService.getInstance().gitPush()
                }
                "git_pull" -> respondWith(command, relay) {
                    ProjectOpsService.getInstance().gitPull()
                }
                "git_resolve" -> respondWith(command, relay) {
                    val p = command.payload.get("path")?.asString
                    val side = command.payload.get("side")?.asString
                    if (p.isNullOrEmpty() || side.isNullOrEmpty()) throw CommandFailed("Missing path or side")
                    ProjectOpsService.getInstance().gitResolve(p, side)
                }
                "cancel_task" -> {
                    logger.info("Command: cancel_task")
                    relay.sendResult(command.id, "completed", com.google.gson.JsonObject().apply {
                        addProperty("message", "Task cancelled")
                    })
                }
                "list_agents" -> {
                    // Forced re-detection from the mobile side. VS Code's
                    // controller-panel.ts:418 does the same; without this
                    // arm the mobile UI couldn't refresh agent state when
                    // the user installed Copilot or signed in mid-session.
                    // detectInstalledAgents() runs runBlocking inside; pin
                    // to a background thread so we don't park the dispatch.
                    // respondWith runs INSIDE the pooled thread: before
                    // this, a throw from detectInstalledAgents() left the
                    // command with no terminal result at all (the bare
                    // async-callback hang).
                    ApplicationManager.getApplication().executeOnPooledThread {
                        respondWith(command, relay) {
                            ide.clearCache()
                            val agents = ide.detectInstalledAgents()
                            relay.reportAgents()
                            val payload = com.google.gson.JsonObject()
                            val arr = com.google.gson.JsonArray()
                            for (a in agents) {
                                arr.add(com.google.gson.JsonObject().apply {
                                    addProperty("id", a.id)
                                    addProperty("name", a.name)
                                    addProperty("icon", a.icon)
                                    addProperty("installed", a.installed)
                                })
                            }
                            payload.add("agents", arr)
                            payload
                        }
                    }
                }
                "list_sessions" -> {
                    // VS Code reads its LM chat history here
                    // (ChatHistoryService.pushSessions). The JB plugin
                    // doesn't surface that today — return an empty list
                    // so mobile gets a typed completion instead of an
                    // "Unknown command" failure.
                    relay.sendResult(command.id, "completed", com.google.gson.JsonObject().apply {
                        add("sessions", com.google.gson.JsonArray())
                    })
                }
                "resume_session" -> {
                    // Mirror AgentBridgeService.handleAgentCommand's
                    // `resume_session` arm: Ctrl+C the running prompt,
                    // brief pause, then re-enter Claude with `--resume`.
                    val sessionId = command.payload.get("id")?.asString
                    if (sessionId.isNullOrEmpty()) {
                        relay.sendResult(command.id, "failed", com.google.gson.JsonObject().apply {
                            addProperty("error", "Missing session id")
                        })
                    } else {
                        // Terminal-agent resume is owned by codeam-cli;
                        // the plugin has no Claude PTY to Ctrl+C + resume.
                        relay.sendResult(command.id, "failed", com.google.gson.JsonObject().apply {
                            addProperty("error", "Unknown session id: $sessionId")
                        })
                    }
                }
                "get_context" -> respondWith(command, relay) {
                    // Try Copilot's internal context-window API first.
                    // Returns the same shape the CLI's `ContextUsage`
                    // produces (used/total/percent/model) plus an
                    // optional `breakdown` map with the per-section
                    // fractions Copilot exposes (system / tool defs /
                    // user messages / assistant messages / files /
                    // tool results) — mobile shows these as a
                    // tooltip if present.
                    val ctx = CopilotChatMetadataBridge.readContextWindow(project)
                    val payload = com.google.gson.JsonObject()
                    if (ctx != null) {
                        payload.addProperty("used", ctx.used)
                        payload.addProperty("total", ctx.total)
                        payload.addProperty("percent", ctx.percent)
                        payload.addProperty("model", ctx.model)
                        payload.addProperty("outputTokens", 0)
                        payload.addProperty("cacheReadTokens", 0)
                        payload.addProperty("monthlyCost", 0)
                        if (ctx.breakdown.isNotEmpty()) {
                            val br = com.google.gson.JsonObject()
                            ctx.breakdown.forEach { (k, v) -> br.addProperty(k, v) }
                            payload.add("breakdown", br)
                        }
                        if (ctx.rateLimitReset != null) {
                            payload.addProperty("rateLimitReset", ctx.rateLimitReset)
                        }
                    } else {
                        // Sentinel: no Copilot, or chat hasn't run a
                        // turn yet. Mobile interprets zeros + error as
                        // "context unknown — hide indicator".
                        payload.addProperty("used", 0)
                        payload.addProperty("total", 200000)
                        payload.addProperty("percent", 0)
                        payload.addProperty("model", null as String?)
                        payload.addProperty("outputTokens", 0)
                        payload.addProperty("cacheReadTokens", 0)
                        payload.addProperty("monthlyCost", 0)
                        payload.addProperty("error", "Token usage not available (send a prompt first or Copilot not active)")
                    }
                    payload
                }
                "get_conversation" -> {
                    // No JSONL parsing on the JB side — the per-turn
                    // `claude-conversation` upload (mode:'append') keeps
                    // the canonical history fresh on the backend, so the
                    // mobile canonical-refresh path still works. Just
                    // ack with a null id so mobile knows there's nothing
                    // to load directly from the plugin.
                    relay.sendResult(command.id, "completed", com.google.gson.JsonObject().apply {
                        add("conversationId", null)
                    })
                }
                "list_models" -> respondWith(command, relay) {
                    // Try Copilot's real model catalog first (Anthropic
                    // Sonnet, OpenAI GPT, Google Gemini, etc. — owned by
                    // GitHub's backend, drifts independently of our
                    // CLI's hardcoded Anthropic-only list). Falls back
                    // to the CLI catalog if Copilot isn't installed.
                    val copilotModels = CopilotChatMetadataBridge.listModels(project)
                    val models = com.google.gson.JsonArray()
                    if (copilotModels != null) {
                        for (m in copilotModels.all) {
                            models.add(com.google.gson.JsonObject().apply {
                                addProperty("id", m.id)
                                addProperty("label", m.label)
                                addProperty("description", if (m.preview) "preview" else "")
                                addProperty("family", m.family ?: "")
                                addProperty("vendor", "github-copilot")
                                addProperty("isDefault", m.isDefault)
                                addProperty("isActive", m.id == copilotModels.active)
                            })
                        }
                    } else {
                        // CLI fallback catalog — mirrors the Claude
                        // runtime's hardcoded list in
                        // apps/cli/src/agents/claude/runtime.ts
                        // (listModels; NOT start/handlers.ts, which only
                        // delegates to the runtime). Drift is guarded by
                        // CliModelCatalogDriftTest.
                        CLI_FALLBACK_MODELS.forEach { m ->
                            models.add(com.google.gson.JsonObject().apply {
                                addProperty("id", m.id)
                                addProperty("label", m.label)
                                addProperty("description", m.description)
                                addProperty("family", "claude")
                                addProperty("vendor", "anthropic")
                                addProperty("isDefault", m.id == CLI_FALLBACK_DEFAULT_MODEL_ID)
                            })
                        }
                    }
                    com.google.gson.JsonObject().apply {
                        add("models", models)
                        if (copilotModels?.active != null) addProperty("active", copilotModels.active)
                    }
                }
                "set_model" -> {
                    // Switch the active Copilot Chat model from the
                    // mobile/web picker. Returns success=true if the
                    // bridge dispatched ChatAction.ModelSelected, which
                    // also persists via Copilot's
                    // UserSelectedModelService (the picker UI's own
                    // store). Falls back to no-op for non-Copilot.
                    val modelId = command.payload.get("modelId")?.asString
                        ?: command.payload.get("id")?.asString ?: ""
                    val applied = if (modelId.isNotBlank())
                        CopilotChatMetadataBridge.selectModel(project, modelId)
                    else false
                    val payload = com.google.gson.JsonObject().apply {
                        addProperty("modelId", modelId)
                        addProperty("applied", applied)
                    }
                    if (!applied) {
                        val msg = "Could not switch model (Copilot not active or modelId not in catalog)"
                        payload.addProperty("error", msg)
                        throw CommandFailed(msg, payload)
                    }
                    payload
                }
                "set_keep_alive" -> {
                    // "Avoid suspend codespace on inactivity" toggle. The
                    // JetBrains plugin always runs locally; report
                    // `applied: false` so mobile hides the UI affordance.
                    val enabled = command.payload.get("enabled")?.asBoolean ?: false
                    relay.sendResult(command.id, "success", com.google.gson.JsonObject().apply {
                        addProperty("enabled", enabled)
                        addProperty("applied", false)
                        addProperty("runtime", "local")
                    })
                }
                "session_terminated", "shutdown_session" -> {
                    // Mobile/web "Delete" or "Stop session". Tear
                    // monitoring down and forget the pairing locally so
                    // the user can pair fresh without restarting the IDE.
                    try { AgentOutputMonitor.getInstance().stopMonitoring() } catch (e: Exception) { logger.trace(e) }
                    try { logger.info("Command: cancel_task") } catch (e: Exception) { logger.trace(e) }
                    try { PairingService.getInstance().clearCurrentSession() } catch (e: Exception) { logger.trace(e) }
                    try { relay.stopPolling() } catch (e: Exception) { logger.trace(e) }
                    relay.sendResult(command.id, "success", com.google.gson.JsonObject().apply {
                        addProperty("ok", true)
                    })
                }
                "install_cli_and_pair" -> {
                    // Open the IDE's Terminal tool window and run
                    // `codeam pair`, with `npx -y codeam-cli pair`
                    // as the fallback when the binary isn't on
                    // PATH yet. `;` between the two commands keeps
                    // this working in both POSIX shells and
                    // PowerShell (cmd.exe also accepts `;` as a
                    // command separator).
                    //
                    // Optional payload: { agent: "claude" | "codex" | … }.
                    // When the mobile/web surface knows which agent
                    // the user wanted (tapped Claude Code on the
                    // session screen), it forwards the id so the
                    // pairing CLI skips its own interactive picker.
                    // Normalised via the registry-driven whitelist
                    // (CliAgentId) so an unexpected agent string can't
                    // be shell-spliced into the command line — and an
                    // unknown agent fails loudly instead of silently
                    // dropping the user's choice.
                    try {
                        val rawAgent = command.payload.get("agent")?.asString
                        val pairAgent = CliAgentId.normalizeCliAgentId(rawAgent)
                        if (rawAgent != null && pairAgent == null) {
                            relay.sendResult(command.id, "failed", com.google.gson.JsonObject().apply {
                                addProperty("error", "Unknown or unsupported agent: $rawAgent")
                            })
                            return@invokeLater
                        }
                        val subcommand = if (pairAgent != null) "pair --agent=$pairAgent" else "pair"
                        val terminalName = if (pairAgent != null) "codeam pair $pairAgent" else "codeam pair"
                        val terminalView = org.jetbrains.plugins.terminal.TerminalToolWindowManager
                            .getInstance(project)
                        val widget = terminalView.createLocalShellWidget(
                            project.basePath,
                            terminalName,
                        )
                        // Always install/upgrade codeam-cli to
                        // latest, THEN pair. `npm install -g
                        // codeam-cli@latest` is idempotent (no-op
                        // on already-latest, real upgrade otherwise).
                        // `&&` so pair only fires after install
                        // succeeds; final `|| npx` fallback handles
                        // sudo-restricted environments.
                        widget.executeCommand(
                            BuildInstallCommand.forSubcommand(
                                subcommand,
                                System.getProperty("os.name"),
                            ),
                        )
                        relay.sendResult(command.id, "completed", com.google.gson.JsonObject().apply {
                            addProperty(
                                "message",
                                if (pairAgent != null)
                                    "Terminal opened with codeam pair --agent=$pairAgent"
                                else
                                    "Terminal opened with codeam pair",
                            )
                        })
                    } catch (e: Exception) {
                        relay.sendResult(command.id, "failed", com.google.gson.JsonObject().apply {
                            addProperty("error", "Failed to open terminal: ${e.message}")
                        })
                    }
                }
                "install_cli_and_link" -> {
                    // Sibling of install_cli_and_pair for the
                    // `codeam link <agent>` CLI handoff flow.
                    // Mobile sends this when the user taps "Continue
                    // with OAuth" on a plugin-paired IDE: terminal
                    // opens, CLI auto-installs if missing, and
                    // `codeam link <agent>` takes over (pair +
                    // capture + upload).
                    //
                    // Payload: { agent: "claude" | "codex" | … }
                    // (defaults to "claude" when absent). Normalised
                    // via the registry-driven whitelist (CliAgentId)
                    // so an unexpected agent string can't be
                    // shell-spliced into the command line — and an
                    // unknown agent fails loudly instead of silently
                    // substituting claude.
                    try {
                        val rawAgent = command.payload.get("agent")?.asString
                        val safeAgent = if (rawAgent == null) {
                            "claude"
                        } else {
                            CliAgentId.normalizeCliAgentId(rawAgent) ?: run {
                                relay.sendResult(command.id, "failed", com.google.gson.JsonObject().apply {
                                    addProperty("error", "Unknown or unsupported agent: $rawAgent")
                                })
                                return@invokeLater
                            }
                        }
                        val terminalView = org.jetbrains.plugins.terminal.TerminalToolWindowManager
                            .getInstance(project)
                        val widget = terminalView.createLocalShellWidget(
                            project.basePath,
                            "codeam link $safeAgent",
                        )
                        widget.executeCommand(
                            BuildInstallCommand.forSubcommand(
                                "link $safeAgent",
                                System.getProperty("os.name"),
                            ),
                        )
                        relay.sendResult(command.id, "completed", com.google.gson.JsonObject().apply {
                            addProperty("message", "Terminal opened with codeam link $safeAgent")
                        })
                    } catch (e: Exception) {
                        relay.sendResult(command.id, "failed", com.google.gson.JsonObject().apply {
                            addProperty("error", "Failed to open terminal: ${e.message}")
                        })
                    }
                }

                "show_install_command" -> respondWith(command, relay) {
                    // Backend pushes the self-hosted install one-liner
                    // the user copies onto their own box. DISPLAY-ONLY —
                    // we surface a balloon with a "Copy command" action
                    // and never execute it.
                    val installCommand = command.payload.get("command")?.asString
                    if (installCommand.isNullOrBlank()) {
                        throw CommandFailed("Missing command")
                    } else {
                        val notification = NotificationGroupManager.getInstance()
                            .getNotificationGroup("CodeAgent-Mobile")
                            .createNotification(
                                "CodeAgent — self-hosted install",
                                installCommand,
                                NotificationType.INFORMATION,
                            )
                        notification.addAction(object : NotificationAction("Copy command") {
                            override fun actionPerformed(e: AnActionEvent, n: Notification) {
                                Toolkit.getDefaultToolkit().systemClipboard
                                    .setContents(StringSelection(installCommand), null)
                                NotificationGroupManager.getInstance()
                                    .getNotificationGroup("CodeAgent-Mobile")
                                    .createNotification(
                                        "Install command copied to clipboard.",
                                        NotificationType.INFORMATION,
                                    )
                                    .notify(project)
                                n.expire()
                            }
                        })
                        Notifications.Bus.notify(notification, project)
                        com.google.gson.JsonObject().apply {
                            addProperty("message", "Displayed self-hosted install command")
                        }
                    }
                }

                else -> {
                    relay.sendResult(command.id, "failed", com.google.gson.JsonObject().apply {
                        addProperty("error", "Unknown command type: ${command.type}")
                    })
                }
            }
        }
    }

    private fun handleMcpConfigure(
        command: CommandRelayService.RemoteCommand,
        relay: CommandRelayService
    ) {
        try {
            val payload = command.payload
            val scope = payload.get("scope")?.asString ?: "global"
            val mcpsArray = payload.getAsJsonArray("mcps") ?: com.google.gson.JsonArray()
            val targetAgentsArray = payload.getAsJsonArray("targetAgents")

            val mcps = mcpsArray.map { element ->
                val obj = element.asJsonObject
                val serverObj = obj.getAsJsonObject("server")
                val envObj = obj.getAsJsonObject("env") ?: com.google.gson.JsonObject()
                McpEntry(
                    id = obj.get("id").asString,
                    server = McpServerDef(
                        command = serverObj.get("command").asString,
                        args = serverObj.getAsJsonArray("args").map { it.asString }
                    ),
                    env = envObj.entrySet().associate { it.key to it.value.asString }
                )
            }

            val targetAgents = targetAgentsArray?.map { it.asString }

            val request = McpConfigureRequest(
                scope = scope,
                mcps = mcps,
                targetAgents = targetAgents
            )

            val writer = McpConfigWriterService.getInstance()
            val results = writer.configure(request)

            val resultsArray = com.google.gson.JsonArray()
            for (r in results) {
                resultsArray.add(com.google.gson.JsonObject().apply {
                    addProperty("agent", r.agent)
                    addProperty("file", r.file)
                    addProperty("status", r.status)
                    if (r.error != null) addProperty("error", r.error)
                })
            }

            relay.sendResult(command.id, "completed", com.google.gson.JsonObject().apply {
                addProperty("message", "MCP configuration written for ${results.count { it.status == "written" }} agents")
                add("results", resultsArray)
            })
        } catch (e: Exception) {
            relay.sendResult(command.id, "failed", com.google.gson.JsonObject().apply {
                addProperty("error", "MCP configuration failed: ${e.message}")
            })
        }
    }

    private fun handleMcpStatus(
        command: CommandRelayService.RemoteCommand,
        relay: CommandRelayService
    ) {
        try {
            val writer = McpConfigWriterService.getInstance()
            val configured = writer.getConfiguredMcps()

            val allMcpIds = mutableSetOf<String>()
            val agentsArray = com.google.gson.JsonArray()

            for (info in configured) {
                allMcpIds.addAll(info.mcpIds)
                agentsArray.add(com.google.gson.JsonObject().apply {
                    addProperty("agent", info.agent)
                    addProperty("configFile", info.configFile)
                    val idsArr = com.google.gson.JsonArray()
                    info.mcpIds.forEach { idsArr.add(it) }
                    add("mcpIds", idsArr)
                })
            }

            val allIdsArray = com.google.gson.JsonArray()
            allMcpIds.forEach { allIdsArray.add(it) }

            relay.sendResult(command.id, "completed", com.google.gson.JsonObject().apply {
                add("configuredMcpIds", allIdsArray)
                add("agents", agentsArray)
            })
        } catch (e: Exception) {
            relay.sendResult(command.id, "failed", com.google.gson.JsonObject().apply {
                addProperty("error", "Failed to read MCP status: ${e.message}")
            })
        }
    }
}
