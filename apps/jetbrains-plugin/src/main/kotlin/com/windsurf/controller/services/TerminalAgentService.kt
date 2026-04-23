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
                val widget = findTerminalWidget(tab.content.component) ?: return@runOnEdt
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
                val widget = findTerminalWidget(tab.content.component)
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

    private fun findTerminalWidget(component: Component): Any? {
        val targetNames = listOf(
            "org.jetbrains.plugins.terminal.ShellTerminalWidget",
            "org.jetbrains.plugins.terminal.JBTerminalWidget",
            "com.jediterm.terminal.ui.JediTermWidget"
        )
        fun isTarget(comp: Component): Boolean {
            var clazz: Class<*>? = comp.javaClass
            while (clazz != null) {
                if (clazz.name in targetNames) return true
                clazz = clazz.superclass
            }
            return false
        }
        fun search(comp: Component): Component? {
            if (isTarget(comp)) return comp
            if (comp is java.awt.Container) {
                for (child in comp.components) {
                    val found = search(child)
                    if (found != null) return found
                }
            }
            return null
        }
        return search(component)
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
                    dumpComponentTree(rootComponent, tree, 0)
                    logger.info("Claude Code terminal component tree:\n$tree")
                    loggedComponentTree = true
                }

                // Strategy 1: Find IntelliJ Editor components (block terminal uses Editor)
                text = tryReadFromEditors(rootComponent)
                if (text != null) {
                    logger.info("readTerminalText: Strategy 1 (Editor) captured ${text?.length} chars")
                    return@Runnable
                }

                // Strategy 2: Find JediTerm widget and read its text buffer
                val widget = findTerminalWidget(rootComponent)
                if (widget != null) {
                    if (!loggedWidgetInfo) {
                        logWidgetDetails(widget)
                        loggedWidgetInfo = true
                    }
                    text = readFromTerminalWidget(widget)
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
                text = tryAggressiveFieldWalk(rootComponent, 0)
                if (text != null) {
                    logger.info("readTerminalText: Strategy 3 (AggressiveFieldWalk) captured ${text?.length} chars")
                    return@Runnable
                }

                // Strategy 4: Terminal model via deep reflection on component tree
                text = tryTerminalModelRead(rootComponent)
                if (text != null) {
                    logger.info("readTerminalText: Strategy 4 (TerminalModel) captured ${text?.length} chars")
                    return@Runnable
                }

                // Strategy 5: Find JTextComponent children
                val textComponents = mutableListOf<JTextComponent>()
                collectTextComponents(rootComponent, textComponents)
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
                collectAccessibleText(rootComponent, accessibleText, 0)
                if (accessibleText.isNotBlank()) {
                    text = accessibleText.toString().trim()
                    logger.info("readTerminalText: Strategy 6 (Accessible) captured ${text?.length} chars")
                    return@Runnable
                }

                // Strategy 7: Generic reflection
                text = tryReflectionRead(rootComponent)
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

    private fun logWidgetDetails(widget: Any) {
        val cls = widget.javaClass
        val methods = cls.methods.map { it.name }.distinct().sorted()
        logger.info("Terminal widget class: ${cls.name}")
        logger.info("Terminal widget methods: ${methods.joinToString(", ")}")

        var parent: Class<*>? = cls.superclass
        val hierarchy = mutableListOf(cls.name)
        while (parent != null && parent != Any::class.java) {
            hierarchy.add(parent.name)
            parent = parent.superclass
        }
        logger.info("Terminal widget hierarchy: ${hierarchy.joinToString(" → ")}")
    }

    private fun tryReadFromEditors(component: Component): String? {
        try {
            val editorClass = Class.forName("com.intellij.openapi.editor.impl.EditorComponentImpl")
            val editors = mutableListOf<Any>()
            collectComponentsByClass(component, editorClass, editors)
            if (editors.isNotEmpty()) {
                val sb = StringBuilder()
                for (editor in editors) {
                    try {
                        val getEditor = editor.javaClass.getMethod("getEditor")
                        val editorObj = getEditor.invoke(editor)
                        val getDocument = editorObj.javaClass.getMethod("getDocument")
                        val doc = getDocument.invoke(editorObj)
                        val getText = doc.javaClass.getMethod("getText")
                        val text = getText.invoke(doc)?.toString()
                        if (!text.isNullOrBlank()) sb.appendLine(text)
                    } catch (_: Exception) {}
                }
                val result = sb.toString().trim()
                if (result.length > 5) return result
            }
        } catch (_: Exception) {}
        return null
    }

    private fun collectComponentsByClass(component: Component, targetClass: Class<*>, result: MutableList<Any>) {
        if (targetClass.isInstance(component)) {
            result.add(component)
        }
        if (component is java.awt.Container) {
            for (child in component.components) {
                collectComponentsByClass(child, targetClass, result)
            }
        }
    }

    private fun readFromTerminalWidget(widget: Any): String? {
        // Try getTerminalTextBuffer() → TerminalTextBuffer (public API)
        for (bufferMethod in listOf("getTerminalTextBuffer", "getTextBuffer")) {
            try {
                val buffer = widget.javaClass.getMethod(bufferMethod).invoke(widget) ?: continue
                logger.info("readFromTerminalWidget: found buffer via $bufferMethod → ${buffer.javaClass.name}")
                val bufferText = readTerminalTextBuffer(buffer)
                if (!bufferText.isNullOrBlank()) return bufferText
            } catch (e: Exception) {
                logger.debug("readFromTerminalWidget: $bufferMethod failed: ${e.message}")
            }
        }

        // Try getTerminal() → Terminal → getTextBuffer()
        try {
            val terminal = widget.javaClass.getMethod("getTerminal").invoke(widget)
            if (terminal != null) {
                logger.info("readFromTerminalWidget: found terminal → ${terminal.javaClass.name}")
                for (bufferMethod in listOf("getTextBuffer", "getTerminalTextBuffer")) {
                    try {
                        val buffer = terminal.javaClass.getMethod(bufferMethod).invoke(terminal) ?: continue
                        val bufferText = readTerminalTextBuffer(buffer)
                        if (!bufferText.isNullOrBlank()) return bufferText
                    } catch (_: Exception) {}
                }
            }
        } catch (_: Exception) {}

        // Try getTerminalPanel() → TerminalPanel → getTerminalTextBuffer()
        try {
            val panel = widget.javaClass.getMethod("getTerminalPanel").invoke(widget)
            if (panel != null) {
                logger.info("readFromTerminalWidget: found panel → ${panel.javaClass.name}")
                for (bufferMethod in listOf("getTerminalTextBuffer", "getTextBuffer")) {
                    try {
                        val buffer = panel.javaClass.getMethod(bufferMethod).invoke(panel) ?: continue
                        val bufferText = readTerminalTextBuffer(buffer)
                        if (!bufferText.isNullOrBlank()) return bufferText
                    } catch (_: Exception) {}
                }
                val bufferText = extractTextFromTerminalObject(panel)
                if (!bufferText.isNullOrBlank()) return bufferText
            }
        } catch (_: Exception) {}

        // Walk declared fields with setAccessible to find buffer objects
        val visited = mutableSetOf<Int>()
        return walkFieldsForBuffer(widget, 0, visited)
    }

    private fun walkFieldsForBuffer(obj: Any, depth: Int, visited: MutableSet<Int>): String? {
        if (depth > 4) return null
        val id = System.identityHashCode(obj)
        if (id in visited) return null
        visited.add(id)

        var cls: Class<*>? = obj.javaClass
        while (cls != null && cls != Any::class.java) {
            for (field in cls.declaredFields) {
                try {
                    field.isAccessible = true
                    val value = field.get(obj) ?: continue
                    val valClass = value.javaClass.name

                    // Check if this is a text buffer
                    if (valClass.contains("TextBuffer", ignoreCase = true) ||
                        valClass.contains("TerminalModel", ignoreCase = true) ||
                        valClass.contains("OutputModel", ignoreCase = true)) {
                        logger.info("walkFieldsForBuffer: found ${field.name}: $valClass")
                        val text = readTerminalTextBuffer(value)
                        if (!text.isNullOrBlank()) return text
                        val text2 = extractTextFromTerminalObject(value)
                        if (!text2.isNullOrBlank()) return text2
                    }

                    // Recurse into terminal-related objects
                    if (valClass.contains("Terminal", ignoreCase = true) ||
                        valClass.contains("Session", ignoreCase = true) ||
                        valClass.contains("JediTerm", ignoreCase = true)) {
                        val result = walkFieldsForBuffer(value, depth + 1, visited)
                        if (result != null) return result
                    }
                } catch (_: Exception) {}
            }
            cls = cls.superclass
        }
        return null
    }

    private fun tryAggressiveFieldWalk(component: Component, depth: Int): String? {
        if (depth > 3) return null
        val visited = mutableSetOf<Int>()
        val result = walkFieldsForBuffer(component, 0, visited)
        if (result != null) return result

        if (component is java.awt.Container) {
            for (child in component.components) {
                val childResult = tryAggressiveFieldWalk(child, depth + 1)
                if (childResult != null) return childResult
            }
        }
        return null
    }

    private fun readTerminalTextBuffer(buffer: Any): String? {
        // Try getScreenLines() — returns all visible screen content
        try {
            val screenLines = buffer.javaClass.getMethod("getScreenLines").invoke(buffer)?.toString()
            if (!screenLines.isNullOrBlank() && screenLines.length > 3) {
                logger.info("readTerminalTextBuffer: getScreenLines returned ${screenLines.length} chars")
                return screenLines
            }
        } catch (_: Exception) {}

        // Try lock + getScreenLines for thread-safe access
        try {
            val lockMethod = buffer.javaClass.getMethod("lock")
            val unlockMethod = buffer.javaClass.getMethod("unlock")
            lockMethod.invoke(buffer)
            try {
                val screenLines = buffer.javaClass.getMethod("getScreenLines").invoke(buffer)?.toString()
                if (!screenLines.isNullOrBlank() && screenLines.length > 3) {
                    unlockMethod.invoke(buffer)
                    return screenLines
                }
            } finally {
                try { unlockMethod.invoke(buffer) } catch (_: Exception) {}
            }
        } catch (_: Exception) {}

        // Try reading line by line: getHeight() + getLine(int)
        try {
            val height = buffer.javaClass.getMethod("getHeight").invoke(buffer) as Int
            val sb = StringBuilder()
            for (i in 0 until height) {
                try {
                    val line = buffer.javaClass.getMethod("getLine", Int::class.javaPrimitiveType)
                        .invoke(buffer, i)
                    if (line != null) sb.appendLine(line.toString())
                } catch (_: Exception) {}
            }
            if (sb.isNotBlank()) return sb.toString().trim()
        } catch (_: Exception) {}

        // Try historyBuffer + screenBuffer
        try {
            val historyText = StringBuilder()
            for (name in listOf("getHistoryBuffer", "getHistoryLines")) {
                try {
                    val history = buffer.javaClass.getMethod(name).invoke(buffer)
                    if (history != null) historyText.append(history.toString())
                } catch (_: Exception) {}
            }
            val screenText = try {
                buffer.javaClass.getMethod("getScreenLines").invoke(buffer)?.toString() ?: ""
            } catch (_: Exception) { "" }
            val combined = (historyText.toString() + "\n" + screenText).trim()
            if (combined.length > 3) return combined
        } catch (_: Exception) {}

        return null
    }

    private fun dumpComponentTree(component: Component, sb: StringBuilder, depth: Int) {
        if (depth > 6) return
        val indent = "  ".repeat(depth)
        sb.appendLine("$indent${component.javaClass.name} [${component.width}x${component.height}]")
        if (component is java.awt.Container) {
            for (child in component.components) {
                dumpComponentTree(child, sb, depth + 1)
            }
        }
    }

    private fun tryTerminalModelRead(component: Component): String? {
        try {
            val cls = component.javaClass

            // BlockTerminalPanel / TerminalPanel — try to get the session or controller
            for (fieldName in listOf("mySession", "myTerminal", "myController", "myTermWidget",
                "terminalWidget", "myContent", "myBlockTerminalView")) {
                try {
                    val field = findFieldRecursive(cls, fieldName) ?: continue
                    field.isAccessible = true
                    val obj = field.get(component) ?: continue

                    // Try getTerminalTextBuffer or similar on the session/terminal object
                    val bufferText = extractTextFromTerminalObject(obj)
                    if (bufferText != null && bufferText.length > 10) return bufferText
                } catch (_: Exception) {}
            }

            // Try methods on the component itself
            for (methodName in listOf("getTerminalTextBuffer", "getText", "getOutputModel",
                "getController", "getSession", "getTerminalModel")) {
                try {
                    val method = cls.getMethod(methodName)
                    val result = method.invoke(component) ?: continue
                    val bufferText = extractTextFromTerminalObject(result)
                    if (bufferText != null && bufferText.length > 10) return bufferText
                } catch (_: Exception) {}
            }
        } catch (_: Exception) {}

        // Recurse into child components
        if (component is java.awt.Container) {
            for (child in component.components) {
                val result = tryTerminalModelRead(child)
                if (result != null) return result
            }
        }
        return null
    }

    private fun findFieldRecursive(cls: Class<*>, name: String): java.lang.reflect.Field? {
        var current: Class<*>? = cls
        while (current != null && current != Any::class.java) {
            try {
                return current.getDeclaredField(name)
            } catch (_: NoSuchFieldException) {}
            current = current.superclass
        }
        return null
    }

    private fun extractTextFromTerminalObject(obj: Any): String? {
        // Try common methods to extract text from terminal session/buffer objects
        for (methodName in listOf("getTerminalTextBuffer", "getTextBuffer", "getText",
            "getScreenLines", "getHistoryBuffer", "getAllText")) {
            try {
                val method = obj.javaClass.getMethod(methodName)
                val result = method.invoke(obj) ?: continue
                val text = result.toString()
                if (text.length > 10 && !text.startsWith("com.") && !text.startsWith("org.")) {
                    return text
                }
                // For buffer objects, try getLines/getText on the result
                for (subMethod in listOf("getLines", "getText", "toString", "getScreenLines")) {
                    try {
                        val sub = result.javaClass.getMethod(subMethod)
                        val subResult = sub.invoke(result)?.toString()
                        if (!subResult.isNullOrBlank() && subResult.length > 10) return subResult
                    } catch (_: Exception) {}
                }
            } catch (_: Exception) {}
        }

        // Try to read all lines from the buffer if it has size/getLine methods
        try {
            val lineCountMethod = obj.javaClass.getMethod("getLineCount")
            val lineCount = lineCountMethod.invoke(obj) as Int
            if (lineCount > 0) {
                val getLineMethod = obj.javaClass.getMethod("getLine", Int::class.javaPrimitiveType)
                val sb = StringBuilder()
                for (i in 0 until minOf(lineCount, 500)) {
                    val line = getLineMethod.invoke(obj, i)?.toString()
                    if (line != null) sb.appendLine(line)
                }
                if (sb.isNotBlank()) return sb.toString().trim()
            }
        } catch (_: Exception) {}

        return null
    }

    private fun collectTextComponents(component: Component, result: MutableList<JTextComponent>) {
        if (component is JTextComponent) {
            result.add(component)
        }
        if (component is java.awt.Container) {
            for (child in component.components) {
                collectTextComponents(child, result)
            }
        }
    }

    private fun collectAccessibleText(component: Component, sb: StringBuilder, depth: Int) {
        if (depth > 15) return
        try {
            val ctx = component.accessibleContext
            if (ctx != null) {
                val at = ctx.accessibleText
                if (at != null) {
                    val charCount = at.getCharCount()
                    if (charCount > 0) {
                        val txt = at.getAtIndex(AccessibleText.SENTENCE, 0)
                        if (txt != null) {
                            sb.appendLine(txt)
                        } else {
                            // Read character by character for short segments
                            val readLen = minOf(charCount, 5000)
                            val chars = StringBuilder()
                            for (i in 0 until readLen) {
                                val c = at.getAtIndex(AccessibleText.CHARACTER, i)
                                if (c != null) chars.append(c)
                            }
                            if (chars.isNotBlank()) sb.appendLine(chars.toString())
                        }
                    }
                }
                // Also try accessible name/description
                val name = ctx.accessibleName
                val desc = ctx.accessibleDescription
                if (!name.isNullOrBlank() && name.length > 10) sb.appendLine(name)
                if (!desc.isNullOrBlank() && desc.length > 10) sb.appendLine(desc)
            }
        } catch (_: Exception) {}
        if (component is java.awt.Container) {
            for (child in component.components) {
                collectAccessibleText(child, sb, depth + 1)
            }
        }
    }

    private fun tryReflectionRead(component: Component): String? {
        // Walk component tree looking for objects with terminal buffer methods
        try {
            val cls = component.javaClass
            // Try getModel() — some terminal views expose output model
            for (methodName in listOf("getModel", "getSession", "getTerminalTextBuffer",
                "getTerminal", "getTextBuffer", "getOutput", "getDocument")) {
                try {
                    val method = cls.getMethod(methodName)
                    val result = method.invoke(component)
                    if (result != null) {
                        val text = result.toString()
                        if (text.length > 20 && !text.startsWith("org.") && !text.startsWith("com.")) {
                            return text
                        }
                        // Try toString on children methods
                        for (subMethod in listOf("getText", "toString", "getTextBuffer")) {
                            try {
                                val sub = result.javaClass.getMethod(subMethod)
                                val subResult = sub.invoke(result)?.toString()
                                if (!subResult.isNullOrBlank() && subResult.length > 20) return subResult
                            } catch (_: Exception) {}
                        }
                    }
                } catch (_: Exception) {}
            }
        } catch (_: Exception) {}

        if (component is java.awt.Container) {
            for (child in component.components) {
                val result = tryReflectionRead(child)
                if (result != null) return result
            }
        }
        return null
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

        clearRemoteOutput(sessionId)

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
                pushOutput(sessionId, "text", responseText, done = true)
                stopMonitoring()
            }
            return
        }

        stableCount = 0
        hasContent = true
        lastSentText = responseText

        val preview = responseText.take(80).replace("\n", "\\n")
        logger.info("Terminal output snapshot (${responseText.length} chars): $preview")
        pushOutput(sessionId, "text", responseText, done = false)
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

    // --- API communication (reuse same output API as AgentOutputMonitor) ---

    private fun pushOutput(sessionId: String, type: String, content: String, done: Boolean) {
        val settings = SettingsService.getInstance()
        val pluginId = settings.ensurePluginId()
        val body = JsonObject().apply {
            addProperty("sessionId", sessionId)
            addProperty("pluginId", pluginId)
            addProperty("type", type)
            addProperty("content", content)
            addProperty("done", done)
        }
        val request = Request.Builder()
            .url("${settings.state.apiBaseUrl}/api/commands/output")
            .post(gson.toJson(body).toRequestBody("application/json".toMediaType()))
            .build()
        try {
            httpClient.newCall(request).execute().close()
            logger.info("Pushed terminal output to API: type=$type, done=$done, length=${content.length}")
        } catch (e: Exception) {
            logger.warn("Failed to push terminal output: ${e.message}")
        }
    }

    private fun clearRemoteOutput(sessionId: String) {
        val settings = SettingsService.getInstance()
        val pluginId = settings.ensurePluginId()
        val body = JsonObject().apply {
            addProperty("sessionId", sessionId)
            addProperty("pluginId", pluginId)
            addProperty("clear", true)
        }
        val request = Request.Builder()
            .url("${settings.state.apiBaseUrl}/api/commands/output")
            .post(gson.toJson(body).toRequestBody("application/json".toMediaType()))
            .build()
        try {
            httpClient.newCall(request).execute().close()
        } catch (_: Exception) {}
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
