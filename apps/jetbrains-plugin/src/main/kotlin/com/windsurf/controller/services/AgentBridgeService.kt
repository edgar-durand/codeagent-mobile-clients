package com.windsurf.controller.services

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import java.io.File
import java.util.Base64

@Service(Service.Level.APP)
class AgentBridgeService : WebSocketService.WebSocketListener {

    private val logger = Logger.getInstance(AgentBridgeService::class.java)
    private val gson = Gson()

    data class AgentState(
        var status: String = "idle",
        var currentTaskId: String? = null,
        var currentTaskDescription: String? = null,
        var progress: Int = 0,
        var model: String = "unknown"
    )

    var agentState = AgentState()
        private set

    init {
        WebSocketService.getInstance().addListener(this)
    }

    override fun onConnected() {
        logger.info("Agent bridge connected")
        broadcastAgentState()
    }

    override fun onDisconnected(reason: String) {
        logger.info("Agent bridge disconnected: $reason")
    }

    override fun onMessage(type: String, payload: JsonObject) {
        when (type) {
            "agent_command" -> handleAgentCommand(payload)
            "session_update" -> handleSessionUpdate(payload)
        }
    }

    override fun onError(error: String) {
        logger.warn("Agent bridge error: $error")
    }

    private fun handleAgentCommand(payload: JsonObject) {
        val commandType = payload.get("type")?.asString ?: return
        logger.info("Received agent command: $commandType")

        val inner = payload.getAsJsonObject("payload")

        when (commandType) {
            "start_task" -> {
                var prompt = inner?.get("prompt")?.asString ?: return
                // Handle file attachments
                val files = inner.getAsJsonArray("files")
                if (files != null && files.size() > 0) {
                    for (el in files) {
                        val f = el.asJsonObject
                        val filename = f.get("filename")?.asString ?: continue
                        val base64 = f.get("base64")?.asString ?: continue
                        val tmp = File(System.getProperty("java.io.tmpdir"), "codeagent-${System.currentTimeMillis()}-$filename")
                        tmp.writeBytes(Base64.getDecoder().decode(base64))
                        prompt = "@${tmp.absolutePath} $prompt"
                        // Clean up after 2 min
                        Thread { Thread.sleep(120_000); tmp.delete() }.start()
                    }
                }
                startTask(prompt)
            }
            "stop_task" -> stopCurrentTask()
            "approve_action" -> approveCurrentAction()
            "reject_action" -> rejectCurrentAction()
            "provide_input" -> {
                val input = inner?.get("input")?.asString ?: return
                provideInput(input)
            }
            "cancel_task" -> cancelCurrentTask()
            "select_option" -> {
                val targetIndex = inner?.get("index")?.asInt ?: 0
                val currentIndex = inner?.get("currentIndex")?.asInt ?: 0
                val terminal = TerminalAgentService.getInstance()
                terminal.selectOption(targetIndex, currentIndex)
            }
            "escape_key" -> {
                TerminalAgentService.getInstance().sendEscape()
            }
            "get_context" -> {
                // Not available via IDE plugin — return minimal response
                logger.info("get_context not supported in IDE plugin")
            }
            "resume_session" -> {
                val sessionId = inner?.get("id")?.asString ?: return
                val auto = inner.get("auto")?.asBoolean ?: false
                val resumePrompt = if (auto) "--resume $sessionId --dangerously-skip-permissions" else "--resume $sessionId"
                val terminal = TerminalAgentService.getInstance()
                terminal.sendRawToTerminal("\u0003") // Ctrl+C
                Thread.sleep(500)
                terminal.sendPromptToClaudeCode(resumePrompt)
            }
        }
    }

    private fun handleSessionUpdate(payload: JsonObject) {
        logger.info("Session update received")
    }

    fun startTask(prompt: String) {
        agentState = agentState.copy(
            status = "running",
            currentTaskDescription = prompt,
            progress = 0
        )
        broadcastAgentState()

        // TODO: Integrate with actual Windsurf agent API
        logger.info("Starting task: $prompt")
    }

    fun stopCurrentTask() {
        agentState = agentState.copy(status = "idle", progress = 0)
        broadcastAgentState()
        logger.info("Task stopped")
    }

    fun approveCurrentAction() {
        logger.info("Action approved")
        broadcastEvent("action_approved", JsonObject())
    }

    fun rejectCurrentAction() {
        logger.info("Action rejected")
        broadcastEvent("action_rejected", JsonObject())
    }

    fun provideInput(input: String) {
        logger.info("Input provided: ${input.take(50)}...")
        broadcastEvent("input_provided", JsonObject().apply {
            addProperty("input", input)
        })
    }

    fun cancelCurrentTask() {
        agentState = agentState.copy(status = "idle", currentTaskId = null, progress = 0)
        broadcastAgentState()
        logger.info("Task cancelled")
    }

    fun updateAgentStatus(status: String, taskDescription: String? = null, progress: Int = 0) {
        agentState = agentState.copy(
            status = status,
            currentTaskDescription = taskDescription ?: agentState.currentTaskDescription,
            progress = progress
        )
        broadcastAgentState()
    }

    private fun broadcastAgentState() {
        val ws = WebSocketService.getInstance()
        if (!ws.isConnected) return

        val data = JsonObject().apply {
            addProperty("status", agentState.status)
            addProperty("currentTaskDescription", agentState.currentTaskDescription)
            addProperty("progress", agentState.progress)
            addProperty("model", agentState.model)
        }
        ws.sendAgentEvent("status_changed", agentState.currentTaskId ?: "", data)
    }

    private fun broadcastEvent(eventType: String, data: JsonObject) {
        val ws = WebSocketService.getInstance()
        if (!ws.isConnected) return
        ws.sendAgentEvent(eventType, agentState.currentTaskId ?: "", data)
    }

    companion object {
        fun getInstance(): AgentBridgeService =
            ApplicationManager.getApplication().getService(AgentBridgeService::class.java)
    }
}
