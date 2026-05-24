package com.windsurf.controller.ui

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindowManager
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
import com.windsurf.controller.services.TerminalAgentService
import com.windsurf.controller.services.TerminalOpsService
import com.windsurf.controller.services.strategies.AgentInvocation
import com.windsurf.controller.services.strategies.AgentStrategyRegistry
import com.windsurf.controller.services.strategies.CopilotChatMetadataBridge
import com.windsurf.controller.util.BuildInstallCommand
import org.jetbrains.plugins.terminal.TerminalToolWindowManager
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
                "send_prompt", "start_task" -> {
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
                            relay.sendResult(
                                command.id,
                                "completed",
                                com.google.gson.JsonObject().apply {
                                    addProperty("message", "Switched Copilot model to $modelId")
                                    addProperty("modelId", modelId)
                                    addProperty("applied", true)
                                },
                            )
                            return@invokeLater
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
                                try { Thread.sleep(120_000); tmp.delete() } catch (_: Exception) {}
                            }.start()
                        }
                        if (oversized != null) {
                            writtenPaths.forEach { runCatching { it.delete() } }
                            relay.sendResult(command.id, "failed", com.google.gson.JsonObject().apply {
                                addProperty("error", "Attachment too large: $oversized")
                            })
                            return@invokeLater
                        }
                        if (refs.isNotEmpty()) {
                            prompt = "${refs.joinToString(" ")} $prompt".trim()
                        }
                    }
                    logger.info("Command: start_task")
                    // Resolve the target agent up front so we can hand a
                    // typed `AgentInvocation` to the strategy registry.
                    // The registry then picks the right strategy based on
                    // toolWindowId / pluginId, sends the prompt and wires
                    // up the matching output monitor — everything that
                    // used to live as inline if/else here.
                    val targetAgent = if (agentId != null) {
                        ide.detectInstalledAgents().find { it.id == agentId }
                    } else {
                        ide.detectInstalledAgents().firstOrNull()
                    }
                    val sent = AgentStrategyRegistry.getInstance().execute(
                        AgentInvocation(
                            project = project,
                            agent = targetAgent,
                            prompt = prompt,
                            sessionId = command.sessionId,
                        )
                    )
                    relay.sendResult(command.id, "completed", com.google.gson.JsonObject().apply {
                        addProperty("message", if (sent) "Task started: $prompt" else "Could not deliver prompt — copied to clipboard")
                    })
                }
                "stop_task" -> {
                    AgentStrategyRegistry.getInstance().stop()
                    logger.info("Command: stop_task")
                    relay.sendResult(command.id, "completed", com.google.gson.JsonObject().apply {
                        addProperty("message", "Task stopped")
                    })
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
                "provide_input" -> {
                    val input = command.payload.get("input")?.asString ?: ""
                    logger.info("Command: provide_input (${input.take(50)}…)")
                    ide.sendPromptToIde(input)
                    relay.sendResult(command.id, "completed", com.google.gson.JsonObject().apply {
                        addProperty("message", "Input provided")
                    })
                }
                "mcp_configure" -> {
                    handleMcpConfigure(command, relay)
                }
                "mcp_status" -> {
                    handleMcpStatus(command, relay)
                }
                "read_file" -> {
                    val filePath = command.payload.get("path")?.asString
                    if (filePath.isNullOrEmpty()) {
                        relay.sendResult(command.id, "failed", com.google.gson.JsonObject().apply {
                            addProperty("error", "Missing path")
                        })
                    } else {
                        val res = FileOpsService.getInstance().readFile(filePath)
                        relay.sendResult(command.id, "completed", res)
                    }
                }
                "write_file" -> {
                    val filePath = command.payload.get("path")?.asString
                    val contentEl = command.payload.get("content")
                    if (filePath.isNullOrEmpty() || contentEl == null || contentEl.isJsonNull) {
                        relay.sendResult(command.id, "failed", com.google.gson.JsonObject().apply {
                            addProperty("error", "Missing path or content")
                        })
                    } else {
                        val res = FileOpsService.getInstance().writeFile(filePath, contentEl.asString)
                        relay.sendResult(command.id, "completed", res)
                    }
                }
                "list_files" -> {
                    val q = command.payload.get("query")?.asString
                    relay.sendResult(command.id, "completed", ProjectOpsService.getInstance().listFiles(q))
                }
                "search_files" -> {
                    val query = command.payload.get("query")?.asString
                    if (query.isNullOrBlank()) {
                        relay.sendResult(command.id, "failed", com.google.gson.JsonObject().apply {
                            addProperty("error", "Missing query")
                        })
                    } else {
                        val include = command.payload.getAsJsonArray("include")?.mapNotNull { it.asString }
                        val exclude = command.payload.getAsJsonArray("exclude")?.mapNotNull { it.asString }
                        val maxResults = command.payload.get("maxResults")?.asInt ?: 500
                        relay.sendResult(
                            command.id,
                            "completed",
                            ProjectOpsService.getInstance().searchFiles(
                                query,
                                command.payload.get("caseSensitive")?.asBoolean ?: false,
                                command.payload.get("wholeWord")?.asBoolean ?: false,
                                command.payload.get("regex")?.asBoolean ?: false,
                                include,
                                exclude,
                                maxResults,
                            ),
                        )
                    }
                }
                "terminal_open" -> {
                    val cols = command.payload.get("cols")?.asInt ?: 80
                    val rows = command.payload.get("rows")?.asInt ?: 24
                    val cwd = command.payload.get("cwd")?.asString
                    relay.sendResult(
                        command.id,
                        "completed",
                        TerminalOpsService.getInstance().open(command.sessionId, cols, rows, cwd),
                    )
                }
                "terminal_write" -> {
                    val ts = command.payload.get("sessionId")?.asString
                    val data = command.payload.get("data")?.asString
                    if (ts.isNullOrBlank() || data == null) {
                        relay.sendResult(command.id, "failed", com.google.gson.JsonObject().apply {
                            addProperty("error", "Missing sessionId or data")
                        })
                    } else {
                        val r = TerminalOpsService.getInstance().write(ts, data)
                        val status = if (r.get("ok")?.asBoolean == true) "completed" else "failed"
                        relay.sendResult(command.id, status, r)
                    }
                }
                "terminal_resize" -> {
                    val ts = command.payload.get("sessionId")?.asString
                    val cols = command.payload.get("cols")?.asInt
                    val rows = command.payload.get("rows")?.asInt
                    if (ts.isNullOrBlank() || cols == null || rows == null) {
                        relay.sendResult(command.id, "failed", com.google.gson.JsonObject().apply {
                            addProperty("error", "Missing sessionId / cols / rows")
                        })
                    } else {
                        val r = TerminalOpsService.getInstance().resize(ts, cols, rows)
                        val status = if (r.get("ok")?.asBoolean == true) "completed" else "failed"
                        relay.sendResult(command.id, status, r)
                    }
                }
                "terminal_close" -> {
                    val ts = command.payload.get("sessionId")?.asString
                    if (ts.isNullOrBlank()) {
                        relay.sendResult(command.id, "failed", com.google.gson.JsonObject().apply {
                            addProperty("error", "Missing sessionId")
                        })
                    } else {
                        relay.sendResult(
                            command.id,
                            "completed",
                            TerminalOpsService.getInstance().close(ts),
                        )
                    }
                }
                "git_status" -> {
                    relay.sendResult(command.id, "completed", ProjectOpsService.getInstance().gitStatus())
                }
                "git_diff" -> {
                    val p = command.payload.get("path")?.asString
                    relay.sendResult(command.id, "completed", ProjectOpsService.getInstance().gitDiff(p))
                }
                "git_diff_staged" -> {
                    val p = command.payload.get("path")?.asString
                    relay.sendResult(command.id, "completed", ProjectOpsService.getInstance().gitDiffStaged(p))
                }
                "git_log" -> {
                    val limit = command.payload.get("limit")?.asInt ?: 30
                    relay.sendResult(command.id, "completed", ProjectOpsService.getInstance().gitLog(limit))
                }
                "git_commit" -> {
                    val message = command.payload.get("message")?.asString
                    if (message.isNullOrBlank()) {
                        relay.sendResult(command.id, "failed", com.google.gson.JsonObject().apply {
                            addProperty("error", "Missing message")
                        })
                    } else {
                        val pathsEl = command.payload.getAsJsonArray("paths")
                        val paths = pathsEl?.mapNotNull { it.asString }
                        relay.sendResult(command.id, "completed", ProjectOpsService.getInstance().gitCommit(message, paths))
                    }
                }
                "git_push" -> {
                    relay.sendResult(command.id, "completed", ProjectOpsService.getInstance().gitPush())
                }
                "git_pull" -> {
                    relay.sendResult(command.id, "completed", ProjectOpsService.getInstance().gitPull())
                }
                "git_resolve" -> {
                    val p = command.payload.get("path")?.asString
                    val side = command.payload.get("side")?.asString
                    if (p.isNullOrEmpty() || side.isNullOrEmpty()) {
                        relay.sendResult(command.id, "failed", com.google.gson.JsonObject().apply {
                            addProperty("error", "Missing path or side")
                        })
                    } else {
                        relay.sendResult(command.id, "completed", ProjectOpsService.getInstance().gitResolve(p, side))
                    }
                }
                "select_option" -> {
                    // Navigate Claude Code's React Ink selector to the
                    // chosen index (incl. the trust dialog at first pair).
                    // The CLI counterpart insists arrows + Enter are paced
                    // so React Ink batches keypresses correctly — same
                    // contract honored by `TerminalAgentService.selectOption`.
                    //
                    // selectOption sleeps 80 ms per arrow step + 100 ms
                    // before Enter — for index=10 that's 800 ms+ on the
                    // calling thread. We hand it to a pooled executor so
                    // the EDT (which this lambda runs on via
                    // SwingUtilities.invokeLater) doesn't freeze.
                    val target = command.payload.get("index")?.asInt ?: 0
                    val current = command.payload.get("from")?.asInt
                        ?: command.payload.get("currentIndex")?.asInt
                        ?: 0
                    val cmdId = command.id
                    ApplicationManager.getApplication().executeOnPooledThread {
                        TerminalAgentService.getInstance().selectOption(target, current)
                        relay.sendResult(cmdId, "completed", com.google.gson.JsonObject().apply {
                            addProperty("message", "Option selected")
                        })
                    }
                }
                "escape_key" -> {
                    TerminalAgentService.getInstance().sendEscape()
                    relay.sendResult(command.id, "completed", com.google.gson.JsonObject().apply {
                        addProperty("message", "Escape sent")
                    })
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
                    ApplicationManager.getApplication().executeOnPooledThread {
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
                        relay.sendResult(command.id, "completed", payload)
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
                        val auto = command.payload.get("auto")?.asBoolean ?: false
                        val resumePrompt = if (auto) "--resume $sessionId --dangerously-skip-permissions" else "--resume $sessionId"
                        val terminal = TerminalAgentService.getInstance()
                        // The Ctrl+C → 500ms pause → resume sequence used
                        // to run on the EDT. IntelliJ 2024.2+ raises a
                        // "Slow operations on EDT" red error for any
                        // sleep on the dispatch thread, and the UI froze
                        // visibly for half a second. Hop to a pooled
                        // executor — neither the terminal writes nor
                        // relay.sendResult need EDT.
                        ApplicationManager.getApplication().executeOnPooledThread {
                            terminal.sendRawToTerminal("\u0003")
                            try { Thread.sleep(500) } catch (_: InterruptedException) {
                                Thread.currentThread().interrupt()
                                return@executeOnPooledThread
                            }
                            terminal.sendPromptToClaudeCode(resumePrompt)
                            relay.sendResult(command.id, "completed", com.google.gson.JsonObject().apply {
                                addProperty("message", "Resumed session $sessionId")
                            })
                        }
                    }
                }
                "get_context" -> {
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
                    relay.sendResult(command.id, "completed", payload)
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
                "list_models" -> {
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
                        // CLI fallback catalog. Keep in sync with
                        // apps/cli/src/commands/start/handlers.ts.
                        listOf(
                            Triple("claude-opus-4-7", "Claude Opus 4.7", "Most capable"),
                            Triple("claude-opus-4-6", "Claude Opus 4.6", "Top tier"),
                            Triple("claude-sonnet-4-6", "Claude Sonnet 4.6", "Balanced"),
                            Triple("claude-haiku-4-5-20251001", "Claude Haiku 4.5", "Fastest"),
                        ).forEach { (id, label, description) ->
                            models.add(com.google.gson.JsonObject().apply {
                                addProperty("id", id)
                                addProperty("label", label)
                                addProperty("description", description)
                                addProperty("family", "claude")
                                addProperty("vendor", "anthropic")
                                addProperty("isDefault", id == "claude-sonnet-4-6")
                            })
                        }
                    }
                    relay.sendResult(command.id, "completed", com.google.gson.JsonObject().apply {
                        add("models", models)
                        if (copilotModels?.active != null) addProperty("active", copilotModels.active)
                    })
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
                    relay.sendResult(
                        command.id,
                        if (applied) "completed" else "failed",
                        com.google.gson.JsonObject().apply {
                            addProperty("modelId", modelId)
                            addProperty("applied", applied)
                            if (!applied) addProperty("error", "Could not switch model (Copilot not active or modelId not in catalog)")
                        },
                    )
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
                    try { TerminalAgentService.getInstance().stopMonitoring() } catch (_: Exception) {}
                    try { AgentOutputMonitor.getInstance().stopMonitoring() } catch (_: Exception) {}
                    try { logger.info("Command: cancel_task") } catch (_: Exception) {}
                    try { PairingService.getInstance().clearCurrentSession() } catch (_: Exception) {}
                    try { relay.stopPolling() } catch (_: Exception) {}
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
                    try {
                        val terminalView = org.jetbrains.plugins.terminal.TerminalToolWindowManager
                            .getInstance(project)
                        val widget = terminalView.createLocalShellWidget(
                            project.basePath,
                            "codeam pair",
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
                                "pair",
                                System.getProperty("os.name"),
                            ),
                        )
                        relay.sendResult(command.id, "completed", com.google.gson.JsonObject().apply {
                            addProperty("message", "Terminal opened with codeam pair")
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
                    // Payload: { agent: "claude" | "codex" }
                    // (defaults to "claude"). Sanitised so an
                    // unexpected agent string can't be shell-spliced
                    // into the command line.
                    try {
                        val rawAgent = command.payload.get("agent")?.asString
                        val safeAgent = if (rawAgent == "codex") "codex" else "claude"
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
