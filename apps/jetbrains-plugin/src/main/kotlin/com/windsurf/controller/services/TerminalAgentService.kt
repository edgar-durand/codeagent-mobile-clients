package com.windsurf.controller.services

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.content.Content
import com.google.gson.Gson
import com.google.gson.JsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.awt.Component
import java.awt.event.KeyEvent
import java.lang.ref.WeakReference
import javax.accessibility.AccessibleText
import javax.swing.text.JTextComponent
import java.util.*
import java.util.concurrent.TimeUnit
import javax.swing.SwingUtilities

data class TerminalAgentConfig(
    val id: String,
    val name: String,
    val launchCommand: String,
    val tabNamePattern: String,
    val icon: String,
    val pluginId: String,
    val startupDelayMs: Long = 5000
)

@Service(Service.Level.APP)
class TerminalAgentService {

    private val logger = Logger.getInstance(TerminalAgentService::class.java)
    private val gson = Gson()
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build()

    private var monitorTimer: Timer? = null
    private var isMonitoring = false
    private var currentSessionId: String? = null
    private var lastSentText: String = ""
    private var stableCount: Int = 0
    private var hasContent: Boolean = false
    private var promptText: String = ""
    private var projectRef: WeakReference<Project>? = null
    /**
     * Last `select_prompt` we shipped, expressed as a stable string
     * fingerprint (question + options joined). Suppresses duplicate
     * emissions while the selector is still on screen — without this
     * the polling loop would re-ship the same prompt every tick.
     * Cleared when the selector goes away so a future identical-shape
     * selector is treated as fresh.
     */
    private var lastSelectorSignature: String? = null
    /**
     * Set of `tool|label` signatures we've already shipped as part of
     * the current turn's `chrome_steps` stream. Mirrors the CLI's
     * delta-protocol contract: each tick we re-scan the terminal for
     * chrome lines, and emit only the steps not present in this set
     * (so mobile sees a monotonically growing thinking timeline).
     * Cleared at the start of each turn via `startMonitoring`.
     */
    private val seenChromeSignatures: MutableSet<String> = mutableSetOf()

    companion object {
        private const val POLL_INTERVAL_MS = 2000L
        private const val STABLE_THRESHOLD = 4

        val TERMINAL_AGENTS = listOf(
            TerminalAgentConfig(
                id = "claude_code",
                name = "Claude Code",
                launchCommand = "claude",
                tabNamePattern = "claude",
                icon = "claude",
                pluginId = "com.anthropic.claudecode",
                startupDelayMs = 5000
            )
        )

        fun getInstance(): TerminalAgentService =
            ApplicationManager.getApplication().getService(TerminalAgentService::class.java)
    }

    data class TerminalTab(
        val name: String,
        val content: Content
    )

    fun findClaudeCodeTab(): TerminalTab? {
        val config = TERMINAL_AGENTS.find { it.id == "claude_code" } ?: return null
        return findTerminalAgentTab(config)
    }

    fun findTerminalAgentTab(config: TerminalAgentConfig): TerminalTab? {
        val project = getProject() ?: return null
        var result: TerminalTab? = null

        val task = Runnable {
            try {
                val twManager = ToolWindowManager.getInstance(project)

                val termTw = twManager.getToolWindow("Terminal")
                if (termTw != null) {
                    val names = termTw.contentManager.contents.map { it.displayName ?: "(null)" }
                    logger.info("Terminal tool window tabs: ${names.joinToString(", ")}")
                    for (content in termTw.contentManager.contents) {
                        val name = content.displayName ?: ""
                        if (name.contains(config.tabNamePattern, ignoreCase = true)) {
                            result = TerminalTab(name, content)
                            logger.info("Found ${config.name} terminal tab: '$name'")
                            return@Runnable
                        }
                    }
                }

                for (twId in twManager.toolWindowIds) {
                    if (twId.contains(config.tabNamePattern, ignoreCase = true)) {
                        val tw = twManager.getToolWindow(twId)
                        if (tw != null && tw.contentManager.contents.isNotEmpty()) {
                            val content = tw.contentManager.contents.first()
                            result = TerminalTab(twId, content)
                            logger.info("Found ${config.name} in tool window: '$twId'")
                            return@Runnable
                        }
                    }
                }

                logger.info("${config.name} tab not found. All tool windows: ${twManager.toolWindowIds.joinToString(", ")}")
            } catch (e: Exception) {
                logger.warn("Failed to scan terminal tabs: ${e.message}")
            }
        }

        runOnEdt(task)
        return result
    }

    fun isClaudeCodeAvailable(): Boolean {
        return findClaudeCodeTab() != null
    }

    private fun launchTerminalAgent(config: TerminalAgentConfig): Boolean {
        val project = getProject() ?: return false

        // Strategy 1: Try IntelliJ Terminal API via reflection to create a named tab
        if (createTerminalWithCommand(project, config.launchCommand, config.name)) {
            logger.info("Launched ${config.name} via Terminal API")
            return true
        }

        // Strategy 2: Fallback — open Terminal tool window and type the command via Robot
        logger.info("Terminal API unavailable, using Robot fallback for ${config.name}")
        runOnEdt {
            try {
                val twManager = ToolWindowManager.getInstance(project)
                val termTw = twManager.getToolWindow("Terminal")
                termTw?.show()
                termTw?.activate(null)
            } catch (e: Exception) {
                logger.warn("Failed to show Terminal: ${e.message}")
            }
        }
        Thread.sleep(1500)
        return pasteAndExecute(config.launchCommand)
    }

    private fun createTerminalWithCommand(project: Project, command: String, tabName: String): Boolean {
        var success = false
        runOnEdt {
            // Try TerminalView (IntelliJ 2024.1+)
            try {
                val viewClass = Class.forName("org.jetbrains.plugins.terminal.TerminalView")
                val view = viewClass.getMethod("getInstance", Project::class.java).invoke(null, project)
                val widget = viewClass.getMethod(
                    "createLocalShellWidget", String::class.java, String::class.java
                ).invoke(view, project.basePath ?: ".", tabName)
                widget.javaClass.getMethod("executeCommand", String::class.java).invoke(widget, command)
                success = true
                return@runOnEdt
            } catch (e: Exception) {
                logger.debug("TerminalView API not available: ${e.message}")
            }

            // Try TerminalToolWindowManager (newer IntelliJ versions)
            try {
                val mgrClass = Class.forName("org.jetbrains.plugins.terminal.TerminalToolWindowManager")
                val mgr = mgrClass.getMethod("getInstance", Project::class.java).invoke(null, project)
                val widget = mgrClass.getMethod(
                    "createLocalShellWidget", String::class.java, String::class.java
                ).invoke(mgr, project.basePath ?: ".", tabName)
                widget.javaClass.getMethod("executeCommand", String::class.java).invoke(widget, command)
                success = true
            } catch (e: Exception) {
                logger.debug("TerminalToolWindowManager API not available: ${e.message}")
            }
        }
        return success
    }

    fun sendPromptToClaudeCode(prompt: String): Boolean {
        val config = TERMINAL_AGENTS.find { it.id == "claude_code" } ?: return false
        return sendPromptToTerminalAgent(prompt, config)
    }

    /** Send raw bytes to the Claude Code terminal (no trailing newline). */
    fun sendRawToTerminal(raw: String): Boolean {
        val config = TERMINAL_AGENTS.find { it.id == "claude_code" } ?: return false
        val tab = findTerminalAgentTab(config) ?: return false
        var success = false
        runOnEdt {
            try {
                val widget = TerminalBufferReader.findTerminalWidget(tab.content.component) ?: return@runOnEdt
                // TtyConnector.write(bytes) — raw, no newline appended
                val connector = widget.javaClass.getMethod("getTtyConnector").invoke(widget) ?: return@runOnEdt
                connector.javaClass.getMethod("write", ByteArray::class.java)
                    .invoke(connector, raw.toByteArray())
                success = true
            } catch (_: Exception) {}
        }
        return success
    }

    /** Send Escape key to terminal */
    fun sendEscape(): Boolean = sendRawToTerminal("\u001b")

    /** Navigate selector to target index then press Enter */
    fun selectOption(targetIndex: Int, currentIndex: Int = 0): Boolean {
        val diff = targetIndex - currentIndex
        val arrow = if (diff > 0) "\u001b[B" else "\u001b[A"
        val steps = kotlin.math.abs(diff)
        for (i in 0 until steps) {
            if (!sendRawToTerminal(arrow)) return false
            Thread.sleep(80)
        }
        Thread.sleep(100)
        return sendRawToTerminal("\r")
    }

    fun sendPromptToTerminalAgent(prompt: String, config: TerminalAgentConfig): Boolean {
        val project = getProject() ?: return false

        var tab = findTerminalAgentTab(config)
        val justLaunched = tab == null

        if (tab == null) {
            logger.info("${config.name} not open, launching with command: ${config.launchCommand}")
            val launched = launchTerminalAgent(config)
            if (!launched) {
                logger.warn("Failed to launch ${config.name}")
                return false
            }
            Thread.sleep(config.startupDelayMs)
            tab = findTerminalAgentTab(config)
        }

        // Activate terminal and select the agent tab
        val finalTab = tab
        runOnEdt {
            try {
                val twManager = ToolWindowManager.getInstance(project)
                val termTw = twManager.getToolWindow("Terminal")
                if (termTw != null) {
                    termTw.show()
                    if (finalTab != null) {
                        termTw.contentManager.setSelectedContent(finalTab.content)
                    }
                    termTw.activate(null)
                    logger.info("Terminal activated for ${config.name}")
                }
            } catch (e: Exception) {
                logger.warn("Failed to activate Terminal: ${e.message}")
            }
        }

        Thread.sleep(if (justLaunched) 500 else 1500)

        // Strategy 1: Send text directly via terminal widget API (most reliable, no bracket paste)
        if (finalTab != null && sendTextViaTerminalWidget(finalTab, prompt)) {
            logger.info("Sent prompt to ${config.name} via terminal widget API")
            return true
        }

        // Strategy 2: Fallback to clipboard + Robot paste
        logger.info("Terminal widget API unavailable, falling back to clipboard paste")
        return pasteAndExecute(prompt)
    }

    private fun sendTextViaTerminalWidget(tab: TerminalTab, text: String): Boolean {
        var success = false
        runOnEdt {
            try {
                val widget = TerminalBufferReader.findTerminalWidget(tab.content.component)
                if (widget != null) {
                    // Try ShellTerminalWidget.executeCommand(String)
                    try {
                        widget.javaClass.getMethod("executeCommand", String::class.java)
                            .invoke(widget, text)
                        success = true
                        logger.info("Sent via executeCommand")
                        return@runOnEdt
                    } catch (e: Exception) {
                        logger.debug("executeCommand not available: ${e.message}")
                    }

                    // Try TerminalStarter.sendString(text + newline)
                    try {
                        val starter = widget.javaClass.getMethod("getTerminalStarter").invoke(widget)
                        if (starter != null) {
                            starter.javaClass.getMethod("sendString", String::class.java, Boolean::class.javaPrimitiveType)
                                .invoke(starter, text + "\n", false)
                            success = true
                            logger.info("Sent via TerminalStarter.sendString")
                            return@runOnEdt
                        }
                    } catch (e: Exception) {
                        logger.debug("sendString not available: ${e.message}")
                    }

                    // Try TtyConnector.write(bytes)
                    try {
                        val connector = widget.javaClass.getMethod("getTtyConnector").invoke(widget)
                        if (connector != null) {
                            connector.javaClass.getMethod("write", ByteArray::class.java)
                                .invoke(connector, (text + "\n").toByteArray())
                            success = true
                            logger.info("Sent via TtyConnector.write")
                            return@runOnEdt
                        }
                    } catch (e: Exception) {
                        logger.debug("TtyConnector.write not available: ${e.message}")
                    }
                } else {
                    logger.debug("No terminal widget found in component tree")
                }
            } catch (e: Exception) {
                logger.debug("sendTextViaTerminalWidget failed: ${e.message}")
            }
        }
        return success
    }

    private fun pasteAndExecute(text: String): Boolean {
        try {
            val clipboard = java.awt.Toolkit.getDefaultToolkit().systemClipboard
            clipboard.setContents(java.awt.datatransfer.StringSelection(text), null)
            Thread.sleep(300)
            val robot = java.awt.Robot()
            robot.autoDelay = 50
            val meta = if (com.intellij.openapi.util.SystemInfo.isMac) KeyEvent.VK_META else KeyEvent.VK_CONTROL
            robot.keyPress(meta)
            robot.keyPress(KeyEvent.VK_V)
            robot.keyRelease(KeyEvent.VK_V)
            robot.keyRelease(meta)
            Thread.sleep(300)
            robot.keyPress(KeyEvent.VK_ENTER)
            robot.keyRelease(KeyEvent.VK_ENTER)
            logger.info("Pasted and executed via clipboard: ${text.take(50)}...")
            return true
        } catch (e: Exception) {
            logger.error("Failed to paste and execute: ${e.message}", e)
            return false
        }
    }


    private var loggedComponentTree = false
    private var loggedWidgetInfo = false

    fun readTerminalText(): String? {
        val project = getProject() ?: return null
        var text: String? = null

        val task = Runnable {
            try {
                val tab = findClaudeCodeTab()
                val rootComponent = if (tab != null) {
                    tab.content.component
                } else {
                    val tw = ToolWindowManager.getInstance(project).getToolWindow("Terminal")
                    tw?.component
                }
                if (rootComponent == null) {
                    logger.warn("readTerminalText: no root component found")
                    return@Runnable
                }

                // Log the component tree once for debugging
                if (!loggedComponentTree) {
                    val tree = StringBuilder()
                    TerminalBufferReader.dumpComponentTree(rootComponent, tree, 0)
                    logger.info("Claude Code terminal component tree:\n$tree")
                    loggedComponentTree = true
                }

                // Strategy 1: Find IntelliJ Editor components (block terminal uses Editor)
                text = TerminalBufferReader.tryReadFromEditors(rootComponent)
                if (text != null) {
                    logger.info("readTerminalText: Strategy 1 (Editor) captured ${text?.length} chars")
                    return@Runnable
                }

                // Strategy 2: Find JediTerm widget and read its text buffer
                val widget = TerminalBufferReader.findTerminalWidget(rootComponent)
                if (widget != null) {
                    if (!loggedWidgetInfo) {
                        TerminalBufferReader.logWidgetDetails(widget)
                        loggedWidgetInfo = true
                    }
                    text = TerminalBufferReader.readFromTerminalWidget(widget)
                    if (text != null) {
                        logger.info("readTerminalText: Strategy 2 (TerminalWidget) captured ${text?.length} chars")
                        return@Runnable
                    }
                } else {
                    if (!loggedWidgetInfo) {
                        logger.warn("readTerminalText: findTerminalWidget returned null")
                        loggedWidgetInfo = true
                    }
                }

                // Strategy 3: Walk ALL fields of root component looking for text buffers
                text = TerminalBufferReader.tryAggressiveFieldWalk(rootComponent, 0)
                if (text != null) {
                    logger.info("readTerminalText: Strategy 3 (AggressiveFieldWalk) captured ${text?.length} chars")
                    return@Runnable
                }

                // Strategy 4: Terminal model via deep reflection on component tree
                text = TerminalBufferReader.tryTerminalModelRead(rootComponent)
                if (text != null) {
                    logger.info("readTerminalText: Strategy 4 (TerminalModel) captured ${text?.length} chars")
                    return@Runnable
                }

                // Strategy 5: Find JTextComponent children
                val textComponents = mutableListOf<JTextComponent>()
                TerminalBufferReader.collectTextComponents(rootComponent, textComponents)
                if (textComponents.isNotEmpty()) {
                    val sb = StringBuilder()
                    for (tc in textComponents) {
                        val t = tc.text?.trim()
                        if (!t.isNullOrBlank()) sb.appendLine(t)
                    }
                    if (sb.isNotBlank()) {
                        text = sb.toString().trim()
                        logger.info("readTerminalText: Strategy 5 (JTextComponent) captured ${text?.length} chars")
                        return@Runnable
                    }
                }

                // Strategy 6: Accessible API
                val accessibleText = StringBuilder()
                TerminalBufferReader.collectAccessibleText(rootComponent, accessibleText, 0)
                if (accessibleText.isNotBlank()) {
                    text = accessibleText.toString().trim()
                    logger.info("readTerminalText: Strategy 6 (Accessible) captured ${text?.length} chars")
                    return@Runnable
                }

                // Strategy 7: Generic reflection
                text = TerminalBufferReader.tryReflectionRead(rootComponent)
                if (text != null) {
                    logger.info("readTerminalText: Strategy 7 (Reflection) captured ${text?.length} chars")
                } else {
                    logger.warn("readTerminalText: ALL strategies returned null")
                }
            } catch (e: Exception) {
                logger.warn("Failed to read terminal text: ${e.message}", e)
            }
        }

        runOnEdt(task)
        return text
    }

    // --- Output monitoring (similar to AgentOutputMonitor but for terminal) ---

    fun startMonitoring(sessionId: String, prompt: String) {
        stopMonitoring()
        currentSessionId = sessionId
        promptText = prompt.trim()
        isMonitoring = true
        stableCount = 0
        hasContent = false
        lastSentText = ""
        // Reset per-turn dedup state: chrome timeline restarts on a
        // new turn, and any leftover selector signature is no longer
        // representative of what's on screen.
        seenChromeSignatures.clear()
        lastSelectorSignature = null

        TerminalOutputPublisher.clearRemoteOutput(sessionId)

        monitorTimer = Timer("terminal-output-monitor", true).apply {
            scheduleAtFixedRate(object : TimerTask() {
                override fun run() {
                    try { pollTerminalOutput() } catch (e: Exception) {
                        logger.warn("Terminal monitor poll error: ${e.message}")
                    }
                }
            }, 1000, POLL_INTERVAL_MS)
        }
        logger.info("Terminal output monitoring started for session=$sessionId")
    }

    fun stopMonitoring() {
        monitorTimer?.cancel()
        monitorTimer = null
        isMonitoring = false
        currentSessionId = null
    }

    private fun pollTerminalOutput() {
        val sessionId = currentSessionId ?: return
        val terminalText = readTerminalText()
        if (terminalText == null) {
            logger.info("pollTerminalOutput: readTerminalText returned null")
            return
        }
        logger.info("pollTerminalOutput: raw text length=${terminalText.length}, preview=${terminalText.takeLast(100).replace("\n", "\\n")}")

        // Selector detection. We feed the detector the ANSI-stripped
        // (but otherwise unmodified) screen lines so it can see the
        // chrome glyphs the CLI's `selector.ts` expects. Has to run
        // BEFORE `extractResponseAfterPrompt` / `cleanTerminalOutput`
        // — those pass shred the cursor (❯) and box characters the
        // detector keys on.
        //
        // Critical for cold-pair UX: this is how the trust dialog
        // ("Do you trust the files in this folder?") becomes tappable
        // on mobile. Without it, the plugin user has to physically
        // pick option 1 in the IDE, defeating the remote-control flow.
        val selectorLines = terminalText
            .replace(Regex("\\x1B\\[[0-9;]*[a-zA-Z]"), "")
            .lines()
        val selector = SelectorDetector.detectSelector(selectorLines)
            ?: SelectorDetector.detectListSelector(selectorLines)
        if (selector != null && lastSelectorSignature != selector.signature()) {
            lastSelectorSignature = selector.signature()
            TerminalOutputPublisher.pushSelectPrompt(sessionId, selector)
            // Don't follow with a text chunk — the selector is the turn.
            return
        }
        if (selector == null && lastSelectorSignature != null) {
            // Selector closed (user picked an option, dialog dismissed,
            // etc.) — drop the signature so a future selector with the
            // same options still emits.
            lastSelectorSignature = null
        }

        // Chrome-step delta. Walk the same ANSI-stripped lines and
        // pull anything ChromeParser flags as TUI chrome. Dedup by
        // tool|label signature against everything we've already
        // shipped this turn, then emit just the new ones as one
        // `chrome_steps` chunk so mobile's thinking timeline grows
        // monotonically. Mirrors the CLI's delta protocol.
        val deltaSteps = mutableListOf<ChromeStep>()
        for (line in selectorLines) {
            if (!ChromeParser.isChromeLine(line)) continue
            val step = ChromeParser.parseChromeLine(line) ?: continue
            val sig = step.signature()
            if (seenChromeSignatures.add(sig)) {
                deltaSteps.add(step)
            }
        }
        if (deltaSteps.isNotEmpty()) {
            TerminalOutputPublisher.pushChromeSteps(sessionId, deltaSteps)
        }

        // Extract response: everything after the prompt text
        val responseText = extractResponseAfterPrompt(terminalText)
        if (responseText.isBlank()) {
            logger.info("pollTerminalOutput: extractResponseAfterPrompt returned blank (prompt='${promptText.take(30)}')")
            return
        }

        // Check if content changed
        if (responseText == lastSentText) {
            stableCount++
            if (stableCount >= STABLE_THRESHOLD && hasContent) {
                logger.info("Terminal output stabilized after ${stableCount * POLL_INTERVAL_MS}ms")
                TerminalOutputPublisher.pushOutput(sessionId, "text", responseText, done = true)
                // Per-turn conversation upload — mirrors the CLI's
                // `historySvc.uploadDelta()` from `onTurnComplete`. Posts
                // the user prompt and the final agent response as the
                // turn's delta with `mode: 'append'` so the server's
                // dedup-by-uuid keeps it idempotent. Without this the
                // mobile sessions-list and canonical-refresh paths see
                // an empty history for JB-driven turns.
                try {
                    TerminalOutputPublisher.pushConversationDelta(sessionId, promptText, responseText)
                } catch (e: Exception) {
                    logger.warn("Conversation delta upload failed: ${e.message}")
                }
                stopMonitoring()
            }
            return
        }

        stableCount = 0
        hasContent = true
        lastSentText = responseText

        val preview = responseText.take(80).replace("\n", "\\n")
        logger.info("Terminal output snapshot (${responseText.length} chars): $preview")
        TerminalOutputPublisher.pushOutput(sessionId, "text", responseText, done = false)
    }

    private fun extractResponseAfterPrompt(terminalText: String): String {
        // Claude Code terminal output has the prompt followed by the response
        // Find the last occurrence of the prompt text
        val promptIdx = terminalText.lastIndexOf(promptText)
        if (promptIdx < 0) {
            // Try partial match (first 30 chars of prompt)
            val partialPrompt = promptText.take(30)
            val partialIdx = terminalText.lastIndexOf(partialPrompt)
            if (partialIdx < 0) return ""
            val after = terminalText.substring(partialIdx + partialPrompt.length).trim()
            return cleanTerminalOutput(after)
        }
        val after = terminalText.substring(promptIdx + promptText.length).trim()
        return cleanTerminalOutput(after)
    }

    private fun cleanTerminalOutput(text: String): String {
        // Strip ANSI escape codes
        val ansiRegex = Regex("\\x1B\\[[0-9;]*[a-zA-Z]")
        var cleaned = ansiRegex.replace(text, "")

        // Strip box-drawing and separator lines (─, └, ├, │, ┌, ┐, ┘, ┤, ┬, ┴, ┼, ›)
        cleaned = cleaned.replace(Regex("[─━]+"), "")
        cleaned = cleaned.replace(Regex("^[└├┌┐┘┤┬┴┼│›\\s]+", RegexOption.MULTILINE), "")

        // Strip Claude Code UI chrome patterns only (never strip actual response content)
        val uiPatterns = listOf(
            "? for shortcuts", "tips for getting",
            "Enter to confirm", "Esc to cancel",
            "Yes, I trust this folder", "No, exit",
            "Quick safety check", "Security guide",
            "Claude Code will", "Claude'll be able to"
        )
        for (pattern in uiPatterns) {
            val idx = cleaned.indexOf(pattern, ignoreCase = true)
            if (idx >= 0) {
                val before = cleaned.substring(0, idx).trim()
                if (before.isNotBlank()) {
                    cleaned = before
                }
            }
        }

        // Remove lines that are only whitespace or special chars after cleaning
        cleaned = cleaned.lines()
            .filter { line -> line.trim().length > 1 || line.isBlank() }
            .joinToString("\n")

        return cleaned
            .replace(Regex("\n{3,}"), "\n\n")
            .trim()
    }
private fun getProject(): Project? {
        return projectRef?.get() ?: ProjectManager.getInstance().openProjects.firstOrNull()
    }

    fun setProject(project: Project) {
        projectRef = WeakReference(project)
    }

    private fun runOnEdt(task: Runnable) {
        val app = ApplicationManager.getApplication()
        if (app.isDispatchThread) {
            task.run()
        } else {
            try {
                app.invokeAndWait(task)
            } catch (e: Exception) {
                logger.warn("invokeAndWait failed: ${e.message}")
                task.run()
            }
        }
    }
}
