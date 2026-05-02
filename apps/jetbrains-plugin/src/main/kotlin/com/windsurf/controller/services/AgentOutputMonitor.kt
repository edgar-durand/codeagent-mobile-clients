package com.windsurf.controller.services

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessHandler
import com.intellij.execution.process.ProcessListener
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.util.Key
import com.intellij.openapi.wm.ToolWindowManager
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.awt.Component
import java.awt.Container
import com.sun.net.httpserver.HttpServer
import java.lang.ref.WeakReference
import java.net.InetSocketAddress
import java.util.Timer
import java.util.TimerTask
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import javax.accessibility.AccessibleContext
import javax.accessibility.AccessibleText
import javax.swing.JEditorPane
import javax.swing.JLabel
import javax.swing.JTextArea
import javax.swing.JTextField
import javax.swing.text.JTextComponent

@Service(Service.Level.APP)
class AgentOutputMonitor {

    private val logger = Logger.getInstance(AgentOutputMonitor::class.java)
    private val gson = Gson()
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build()

    private var monitorTimer: Timer? = null
    private var previousSnapshot: String = ""
    private var stableCount: Int = 0
    private var hasEverCapturedContent: Boolean = false
    private var currentSessionId: String? = null
    private var currentToolWindowId: String? = null
    private var projectRef: WeakReference<Project>? = null
    private var isMonitoring: Boolean = false
    private var pollCount: Int = 0
    private var captureServer: HttpServer? = null
    private var capturePort: Int = 0
    private val jcefTextRef = AtomicReference<String?>(null)
    private val jcefHtmlRef = AtomicReference<String?>(null)
    private val jcefResponseTextRef = AtomicReference<String?>(null)
    private val jcefLatch = AtomicReference<CountDownLatch?>(null)
    private var lastCaptureStrategy: String = "none"
    private var jcefConsoleHandlerInstalled = false
    private var jcefOriginalDisplayHandler: Any? = null
    private var jcefCefClient: Any? = null
    private var interceptedHandler: ProcessHandler? = null
    private var processAdapter: ProcessListener? = null
    private val processOutputBuffer = StringBuilder()
    private var processInterceptAttached = false
    private var currentPromptText: String = ""
    private var responseDoneSent: Boolean = false
    private var lastSentResponseText: String = ""

    companion object {
        private const val POLL_INTERVAL_MS = 2000L
        private const val STABLE_THRESHOLD = 3
        private const val MAX_EMPTY_POLLS = 15
        fun getInstance(): AgentOutputMonitor =
            ApplicationManager.getApplication().getService(AgentOutputMonitor::class.java)
    }

    fun startMonitoring(sessionId: String, toolWindowId: String, promptText: String) {
        stopMonitoring()

        currentSessionId = sessionId
        currentToolWindowId = toolWindowId
        currentPromptText = promptText.trim()
        projectRef = WeakReference(
            ProjectManager.getInstance().openProjects.firstOrNull()
        )
        isMonitoring = true
        stableCount = 0
        pollCount = 0
        hasEverCapturedContent = false
        responseDoneSent = false
        lastSentResponseText = ""
        jcefHtmlRef.set(null)
        jcefResponseTextRef.set(null)

        attachToLanguageServerProcess()

        previousSnapshot = captureToolWindowContent() ?: ""
        logger.info("Output monitoring started for session=$sessionId, toolWindow=$toolWindowId, baselineLength=${previousSnapshot.length}")

        clearRemoteOutput(sessionId)

        monitorTimer = Timer("agent-output-monitor", true).apply {
            scheduleAtFixedRate(object : TimerTask() {
                override fun run() {
                    checkForChanges()
                }
            }, POLL_INTERVAL_MS, POLL_INTERVAL_MS)
        }
    }

    fun stopMonitoring() {
        monitorTimer?.cancel()
        monitorTimer = null
        isMonitoring = false
        previousSnapshot = ""
        stableCount = 0
        pollCount = 0
        hasEverCapturedContent = false
        responseDoneSent = false
        detachFromProcess()
        stopCaptureServer()
        cleanupJcefConsoleHandler()
        logger.info("Output monitoring stopped")
    }

    private fun cleanupJcefConsoleHandler() {
        if (!jcefConsoleHandlerInstalled) return
        try {
            val client = jcefCefClient
            val original = jcefOriginalDisplayHandler
            if (client != null && original != null) {
                val addMethod = client.javaClass.methods.find {
                    it.name == "addDisplayHandler" && it.parameterCount == 1
                }
                addMethod?.invoke(client, original)
            }
        } catch (_: Exception) {}
        jcefConsoleHandlerInstalled = false
        jcefOriginalDisplayHandler = null
        jcefCefClient = null
    }

    private fun ensureCaptureServer() {
        if (captureServer != null) return
        try {
            val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 5)
            capturePort = server.address.port
            server.createContext("/capture") { exchange ->
                try {
                    exchange.responseHeaders.add("Access-Control-Allow-Origin", "*")
                    exchange.responseHeaders.add("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                    exchange.responseHeaders.add("Access-Control-Allow-Headers", "*")
                    if (exchange.requestMethod == "OPTIONS") {
                        exchange.sendResponseHeaders(204, -1)
                        exchange.close()
                        return@createContext
                    }
                    val body = if (exchange.requestMethod == "GET") {
                        val query = exchange.requestURI.query ?: ""
                        val params = query.split("&").associate {
                            val parts = it.split("=", limit = 2)
                            parts[0] to java.net.URLDecoder.decode(parts.getOrElse(1) { "" }, "UTF-8")
                        }
                        params["t"] ?: ""
                    } else {
                        exchange.requestBody.bufferedReader().readText()
                    }
                    exchange.sendResponseHeaders(200, -1)
                    exchange.close()
                    logger.info("JCEF HTTP ${exchange.requestMethod} received: ${body.length} chars, prefix=${body.take(80)}")
                    if (body.isNotBlank() && !body.startsWith("empty:")) {
                        jcefTextRef.set(body)
                        jcefLatch.get()?.countDown()
                    }
                } catch (e: Exception) {
                    logger.debug("Capture server handler error: ${e.message}")
                    try { exchange.sendResponseHeaders(500, -1); exchange.close() } catch (_: Exception) {}
                }
            }
            server.executor = null
            server.start()
            captureServer = server
            logger.info("JCEF capture server started on port $capturePort")
        } catch (e: Exception) {
            logger.warn("Failed to start capture server: ${e.message}")
        }
    }

    private fun stopCaptureServer() {
        try { captureServer?.stop(0) } catch (_: Exception) {}
        captureServer = null
        capturePort = 0
        jcefLatch.set(null)
        jcefTextRef.set(null)
    }

    fun isActive(): Boolean = isMonitoring

    private fun checkForChanges() {
        if (!isMonitoring) return

        val sessionId = currentSessionId ?: return
        pollCount++

        val currentContent = captureToolWindowContent() ?: ""

        if (currentContent == previousSnapshot) {
            stableCount++

            if (!hasEverCapturedContent && pollCount >= MAX_EMPTY_POLLS) {
                logger.warn("No content captured after $MAX_EMPTY_POLLS polls, stopping monitor")
                pushOutput(sessionId, "status", "Could not capture agent response. The AI panel may use an unsupported renderer.", done = true)
                stopMonitoring()
                return
            }

            val threshold = if (hasEverCapturedContent) STABLE_THRESHOLD else STABLE_THRESHOLD * 3
            if (stableCount >= threshold && hasEverCapturedContent && !responseDoneSent) {
                logger.info("Agent output stabilized after ${stableCount * POLL_INTERVAL_MS}ms")
                // Send HTML with done=true to avoid race condition (single atomic chunk)
                val html = jcefHtmlRef.get()
                if (html != null && html.length > 20) {
                    val cleanHtml = stripTailwindClasses(html)
                    logger.info("Sending final HTML (${cleanHtml.length} chars)")
                    pushOutput(sessionId, "html", cleanHtml, done = true)
                } else {
                    pushOutput(sessionId, "status", "", done = true)
                }
                // Don't stop monitoring — keep watching for new activity from IDE
                responseDoneSent = true
                jcefHtmlRef.set(null)
            }
            return
        }

        stableCount = 0

        // If we already sent done for previous response, check if this is real new content
        if (responseDoneSent) {
            val currentResponse = extractResponseSnapshot(currentContent)
            // Require meaningful content change (not just minor UI shifts like feedback prompts)
            if (currentResponse.isBlank() || currentResponse == lastSentResponseText || currentResponse.length - lastSentResponseText.length < 15) {
                previousSnapshot = currentContent
                return
            }
            logger.info("New activity detected after done — starting new message cycle (${currentResponse.length} chars)")
            responseDoneSent = false
            hasEverCapturedContent = false
            pollCount = 0
            lastSentResponseText = ""
            clearRemoteOutput(sessionId)
            pushOutput(sessionId, "new_turn", "", done = false)
        }

        // Prefer clean response text from JCEF element, fall back to page extraction
        val jcefResponse = jcefResponseTextRef.get()
        val responseSnapshot = if (!jcefResponse.isNullOrBlank() && jcefResponse.length >= 3) {
            jcefResponse
        } else {
            extractResponseSnapshot(currentContent)
        }
        previousSnapshot = currentContent

        // Skip if response is just an echo of the prompt (appears briefly before agent starts)
        val isPromptEcho = currentPromptText.isNotBlank() &&
            (responseSnapshot.trim() == currentPromptText.trim() ||
             currentPromptText.trim().endsWith(responseSnapshot.trim()) ||
             responseSnapshot.trim().endsWith(currentPromptText.trim()))

        if (responseSnapshot.isNotBlank() && responseSnapshot != lastSentResponseText && !isPromptEcho) {
            hasEverCapturedContent = true
            lastSentResponseText = responseSnapshot
            val preview = responseSnapshot.take(80).replace("\n", "\\n")
            logger.info("New output snapshot (${responseSnapshot.length} chars): $preview")
            pushOutput(sessionId, "text", responseSnapshot, done = false)
        }
    }

    private fun extractResponseSnapshot(currentSnapshot: String): String {
        val cleanText = cleanCapturedText(currentSnapshot)
        if (currentPromptText.isNotBlank()) {
            val response = extractResponseAfterPrompt(cleanText)
            if (response != null) return response
        }
        return ""
    }

    private fun extractResponseAfterPrompt(pageText: String): String? {
        val promptIdx = pageText.lastIndexOf(currentPromptText)
        if (promptIdx < 0) return null
        val afterPrompt = pageText.substring(promptIdx + currentPromptText.length).trim()
        if (afterPrompt.length < 3) return null

        // Known Cascade UI patterns that appear after the agent response
        val uiPatterns = listOf(
            "Feedback submitted",
            "Command Awaiting Approval",
            "Ask anything",
            "Claude Opus",
            "Claude Sonnet",
            "Claude Haiku",
            "GPT-4",
            "Claude 4",
            "Claude 3"
        )

        // Truncate at the first occurrence of a UI pattern (line-start or inline)
        var result = afterPrompt
        for (pattern in uiPatterns) {
            // Try line-start match first
            val lineRegex = Regex("(?m)^\\s*${Regex.escape(pattern)}.*", RegexOption.IGNORE_CASE)
            val lineMatch = lineRegex.find(result)
            if (lineMatch != null) {
                result = result.substring(0, lineMatch.range.first).trim()
                continue
            }
            // Fallback: inline occurrence (handles cases where innerText doesn't have clean line breaks)
            val idx = result.indexOf(pattern, ignoreCase = true)
            if (idx > 0) {
                result = result.substring(0, idx).trim()
            }
        }

        // Strip Cascade UI noise: file change indicators, command blocks, control lines
        result = result
            .replace(Regex("(?m)^\\s*\\S+\\.(kt|ts|tsx|js|jsx|json|md|yaml|yml|css|html|py|java|go|rs|swift|xml|gradle|toml|lock)\\s*$"), "")
            .replace(Regex("(?m)^\\s*[+-]\\d+\\s*$"), "")
            .replace(Regex("(?m)^\\s*Command\\s+.{0,120}$"), "")
            .replace(Regex("(?m)^\\s*(Floating|Surfing|Diving|Sailing|Navigating|Exploring|Searching|Thinking|Analyzing|Planning|Coding|Writing|Reading|Building|Deploying)\\.{0,3}\\s*$"), "")
            .replace(Regex("(?m)^\\s*[\\uD83D\\uDC4D\\uD83D\\uDC4E]+\\s*$"), "")
            .replace(Regex("(?m)^\\s*\\d{1,2}:\\d{2}\\s*(AM|PM)?\\s*$"), "")
            .replace(Regex("(?m)^\\s*<>\\s*Code\\s*$"), "")
            .replace(Regex("(?m)^\\s*\\+\\s*$"), "")
            .replace(Regex("\n{3,}"), "\n\n")
            .trim()

        return if (result.length >= 3) result else null
    }

    private fun stripTailwindClasses(html: String): String {
        // Remove class attributes (Tailwind utility classes won't render in mobile)
        // Keep semantic HTML structure: p, pre, code, strong, em, table, ul, ol, li, h1-h6, a, br, hr
        return html
            .replace(Regex("""\s+class="[^"]*""""), "")
            .replace(Regex("""\s+class='[^']*'"""), "")
            .replace(Regex("""\s+style="[^"]*""""), "")
            .replace(Regex("""\s+data-[a-z-]+="[^"]*""""), "")
    }

    private fun cleanCapturedText(text: String): String {
        return text
            .replace(Regex("Drop to add to \\w+"), "")
            .replace(Regex("(?m)^\\s*Drop to add.*$"), "")
            .replace(Regex("\n{3,}"), "\n\n")
            .trim()
    }

    private fun captureToolWindowContent(): String? {
        val project = projectRef?.get() ?: return null
        val twId = currentToolWindowId ?: return null
        val result = AtomicReference<String?>(null)
        val jcefRequested = AtomicReference(false)

        val app = ApplicationManager.getApplication()
        val edtTask = Runnable {
            try {
                val tw = ToolWindowManager.getInstance(project).getToolWindow(twId)
                if (tw == null) {
                    logger.warn("Tool window not found: $twId")
                    return@Runnable
                }
                val content = tw.contentManager.contents
                val textParts = mutableListOf<String>()
                val componentTypes = mutableSetOf<String>()

                for (c in content) {
                    val component = c.component ?: continue
                    collectSwingText(component, textParts, componentTypes)
                }

                if (pollCount <= 2 && componentTypes.isNotEmpty()) {
                    logger.info("Tool window component types: ${componentTypes.joinToString(", ")}")
                }

                if (textParts.isNotEmpty()) {
                    result.set(textParts.joinToString("\n"))
                } else {
                    for (c in content) {
                        val component = c.component ?: continue
                        val browser = findJBCefBrowser(component)
                        if (browser != null) {
                            setupAndExecuteJcefCapture(browser)
                            jcefRequested.set(true)
                            break
                        }
                    }
                }
            } catch (e: Exception) {
                logger.debug("Failed to capture tool window content: ${e.message}")
            }
        }

        if (app.isDispatchThread) edtTask.run() else {
            try { app.invokeAndWait(edtTask) } catch (e: Exception) {
                logger.debug("invokeAndWait for capture failed: ${e.message}")
            }
        }

        if (result.get() != null) {
            logStrategy("swing")
            return result.get()
        }

        if (jcefRequested.get()) {
            val latch = jcefLatch.get()
            if (latch != null) {
                if (latch.await(3, TimeUnit.SECONDS)) {
                    val text = jcefTextRef.get()?.trim() ?: ""
                    if (text.isNotBlank()) {
                        logStrategy("jcef-console")
                        return text
                    }
                } else {
                    if (pollCount <= 3) logger.debug("JCEF HTTP callback timed out after 3s")
                }
            }
        }

        val editorText = scanEditorsForAgentOutput()
        if (editorText != null) {
            logStrategy("editor-scan")
            return editorText
        }

        val accessibleText = result.get() ?: captureAccessibleText(project, twId)
        if (accessibleText != null) {
            logStrategy("accessible")
            return accessibleText
        }

        val processText = readProcessBuffer()
        if (processText != null) {
            logStrategy("process-intercept")
            return processText
        }

        return null
    }

    private fun logStrategy(strategy: String) {
        if (strategy != lastCaptureStrategy) {
            logger.info("Capture strategy: $strategy")
            lastCaptureStrategy = strategy
        }
    }

    private fun scanEditorsForAgentOutput(): String? {
        var bestText: String? = null
        try {
            val app = ApplicationManager.getApplication()
            val ref = AtomicReference<String?>(null)
            val task = Runnable {
                try {
                    val twId = currentToolWindowId ?: return@Runnable
                    val editors = EditorFactory.getInstance().allEditors
                    for (editor in editors) {
                        val doc = editor.document
                        val text = doc.text
                        if (text.length < 20) continue
                        val vf = com.intellij.openapi.fileEditor.FileDocumentManager.getInstance().getFile(doc)
                        val path = vf?.path ?: ""
                        val name = vf?.name ?: ""
                        val isVirtual = vf != null && !vf.isInLocalFileSystem
                        if (name.contains("cascade", ignoreCase = true)
                            || name.contains("windsurf", ignoreCase = true)
                            || isVirtual
                            || vf?.fileType?.name == "Scratch"
                        ) {
                            if (ref.get() == null || text.length > (ref.get()?.length ?: 0)) {
                                ref.set(text)
                            }
                        }
                    }
                } catch (e: Exception) {
                    logger.debug("Editor scan failed: ${e.message}")
                }
            }
            if (app.isDispatchThread) task.run() else {
                try { app.invokeAndWait(task) } catch (_: Exception) {}
            }
            bestText = ref.get()
        } catch (_: Exception) {}
        return bestText
    }

    private fun captureAccessibleText(project: Project, twId: String): String? {
        val ref = AtomicReference<String?>(null)
        val app = ApplicationManager.getApplication()
        val task = Runnable {
            try {
                val tw = ToolWindowManager.getInstance(project).getToolWindow(twId) ?: return@Runnable
                for (c in tw.contentManager.contents) {
                    val component = c.component ?: continue
                    val sb = StringBuilder()
                    collectAccessibleText(component, sb, 0)
                    val text = sb.toString().trim()
                    if (text.length > 20) {
                        ref.set(text)
                        return@Runnable
                    }
                }
            } catch (_: Exception) {}
        }
        if (app.isDispatchThread) task.run() else {
            try { app.invokeAndWait(task) } catch (_: Exception) {}
        }
        return ref.get()
    }

    private fun collectAccessibleText(component: Component, sb: StringBuilder, depth: Int) {
        if (depth > 15) return
        try {
            val ctx: AccessibleContext? = component.accessibleContext
            if (ctx != null) {
                val at: AccessibleText? = ctx.accessibleText
                if (at != null) {
                    val charCount = at.charCount
                    if (charCount > 0) {
                        val text = at.getAtIndex(AccessibleText.SENTENCE, 0)
                        if (text != null && text.length > 5) sb.appendLine(text)
                    }
                }
                val name = ctx.accessibleName
                if (name != null && name.length > 20) sb.appendLine(name)
                val desc = ctx.accessibleDescription
                if (desc != null && desc.length > 20) sb.appendLine(desc)
            }
        } catch (_: Exception) {}
        if (component is Container) {
            for (i in 0 until component.componentCount) {
                collectAccessibleText(component.getComponent(i), sb, depth + 1)
            }
        }
    }

    private fun collectSwingText(component: Component, textParts: MutableList<String>, types: MutableSet<String>) {
        types.add(component.javaClass.name)
        when (component) {
            is JEditorPane -> {
                val text = component.text ?: ""
                if (text.isNotBlank()) textParts.add(stripHtml(text))
            }
            is JTextArea -> {
                val text = component.text ?: ""
                if (text.isNotBlank()) textParts.add(text)
            }
            is JTextComponent -> {
                val text = component.text ?: ""
                if (text.length > 10 && component !is JTextField) {
                    textParts.add(text)
                }
            }
            is JLabel -> {
                val text = component.text ?: ""
                if (text.length > 20) textParts.add(stripHtml(text))
            }
        }
        if (component is Container) {
            for (i in 0 until component.componentCount) {
                collectSwingText(component.getComponent(i), textParts, types)
            }
        }
    }

    private fun findJBCefBrowser(component: Component): Any? {
        val className = component.javaClass.name

        if (className.contains("\$MyPanel") && className.contains("JBCef")) {
            try {
                val outerField = component.javaClass.getDeclaredField("this\$0")
                outerField.isAccessible = true
                val outer = outerField.get(component)
                if (outer != null) {
                    if (pollCount <= 2) logger.info("Found JBCefBrowser via \$MyPanel->this\$0: ${outer.javaClass.name}")
                    return outer
                }
            } catch (e: Exception) {
                logger.debug("Failed to get outer from \$MyPanel: ${e.message}")
            }
        }

        if (component is Container) {
            for (i in 0 until component.componentCount) {
                val found = findJBCefBrowser(component.getComponent(i))
                if (found != null) return found
            }
        }
        return null
    }

    /**
     * Captures JCEF browser content using CefDisplayHandler.onConsoleMessage().
     *
     * This approach is based on the official JetBrains JCEF documentation:
     * - executeJavaScript() runs code in the existing page context
     * - console.log() triggers CefDisplayHandler.onConsoleMessage() via IPC
     * - Works with both in-process and OOP (out-of-process) JCEF
     * - Does NOT require JBCefJSQuery or JS_QUERY_POOL_SIZE
     *
     * @see <a href="https://plugins.jetbrains.com/docs/intellij/embedded-browser-jcef.html">JCEF Docs</a>
     */
    private fun setupAndExecuteJcefCapture(browser: Any) {
        try {
            val platformCL = browser.javaClass.classLoader
            val jbCefBaseClass = Class.forName("com.intellij.ui.jcef.JBCefBrowserBase", true, platformCL)
            val cefBrowser = jbCefBaseClass.getMethod("getCefBrowser").invoke(browser) ?: return
            val jcefCL = cefBrowser.javaClass.classLoader
            val cefBrowserIface = Class.forName("org.cef.browser.CefBrowser", true, jcefCL)

            val latch = CountDownLatch(1)
            jcefLatch.set(latch)
            jcefTextRef.set(null)

            // Install CefDisplayHandler proxy once to intercept console messages
            if (!jcefConsoleHandlerInstalled) {
                try {
                    val jbCefClient = jbCefBaseClass.getMethod("getJBCefClient").invoke(browser)
                    val cefClient = jbCefClient.javaClass.getMethod("getCefClient").invoke(jbCefClient)
                    jcefCefClient = cefClient

                    val cefDisplayHandlerClass = Class.forName("org.cef.handler.CefDisplayHandler", true, jcefCL)

                    // Preserve existing handler so we can delegate and restore later
                    val getHandlerMethod = cefClient.javaClass.methods.find { it.name == "getDisplayHandler" }
                    val existingHandler = getHandlerMethod?.invoke(cefClient)
                    jcefOriginalDisplayHandler = existingHandler

                    val proxy = java.lang.reflect.Proxy.newProxyInstance(
                        jcefCL, arrayOf(cefDisplayHandlerClass)
                    ) { _, method, args ->
                        val methodArgs = args ?: emptyArray<Any>()

                        if (method.name == "onConsoleMessage") {
                            // Signature: onConsoleMessage(CefBrowser, LogSeverity, String msg, String src, int line)
                            val message = methodArgs.getOrNull(2) as? String
                            if (message != null) {
                                when {
                                    message.startsWith("__CAGENT__:") -> {
                                        val text = message.removePrefix("__CAGENT__:")
                                        if (text.length > 5) {
                                            jcefTextRef.set(text)
                                            jcefLatch.get()?.countDown()
                                            if (pollCount <= 3) logger.info("JCEF console captured: ${text.length} chars")
                                        }
                                    }
                                    message.startsWith("__CAGENT_HTML__:") -> {
                                        val html = message.removePrefix("__CAGENT_HTML__:")
                                        if (html.length > 10) {
                                            jcefHtmlRef.set(html)
                                            val preview = html.take(150).replace("\n", " ")
                                            logger.info("JCEF HTML captured: ${html.length} chars — $preview")
                                        }
                                    }
                                    message.startsWith("__CAGENT_RESPONSE__:") -> {
                                        val text = message.removePrefix("__CAGENT_RESPONSE__:")
                                        if (text.length > 3) {
                                            jcefResponseTextRef.set(text)
                                        }
                                    }
                                    message.startsWith("__CAGENT_DOM__:") -> {
                                        logger.info("JCEF DOM diagnostic: ${message.removePrefix("__CAGENT_DOM__:")}")
                                    }
                                }
                            }
                            // Delegate to original handler
                            if (existingHandler != null) {
                                try { return@newProxyInstance method.invoke(existingHandler, *methodArgs) }
                                catch (_: Exception) {}
                            }
                            return@newProxyInstance false
                        }

                        // Delegate all non-Object methods to original handler
                        if (existingHandler != null && method.declaringClass != Any::class.java) {
                            try { return@newProxyInstance method.invoke(existingHandler, *methodArgs) }
                            catch (_: Exception) {}
                        }

                        // Default return values for unhandled methods
                        when (method.returnType) {
                            Boolean::class.javaPrimitiveType -> false
                            else -> null
                        }
                    }

                    val addMethod = cefClient.javaClass.methods.find {
                        it.name == "addDisplayHandler" && it.parameterCount == 1
                    }
                    if (addMethod != null) {
                        addMethod.invoke(cefClient, proxy)
                        jcefConsoleHandlerInstalled = true
                        logger.info("JCEF: CefDisplayHandler proxy installed (console message capture)")
                    } else {
                        logger.info("JCEF: addDisplayHandler method not found on ${cefClient.javaClass.name}")
                    }
                } catch (e: Exception) {
                    logger.info("JCEF: Console handler setup failed: ${e.javaClass.simpleName}: ${e.message}")
                }
            }

            // Execute JS to capture body text + attempt HTML capture of response elements
            // Use CefFrame interface (exported) instead of concrete RemoteFrame class (non-exported module)
            val escapedPrompt = currentPromptText.replace("'", "\\'")
            val js = """(function(){
              try {
                var t = document.body ? (document.body.innerText || '') : '';
                if (t.length > 5) console.log('__CAGENT__:' + t);

                // Find last agent response HTML via Cascade DOM structure:
                // .cascade-scrollbar > div > div > div[many children] > last-child
                var scroll = document.querySelector('.cascade-scrollbar');
                if (!scroll) return;

                // Find the messages container: deepest descendant with 5+ direct children
                var msgContainer = null;
                var candidates = scroll.querySelectorAll('div');
                for (var i = 0; i < candidates.length; i++) {
                  if (candidates[i].children.length >= 5) {
                    if (!msgContainer || candidates[i].children.length > msgContainer.children.length) {
                      msgContainer = candidates[i];
                    }
                  }
                }
                if (!msgContainer || msgContainer.children.length < 2) return;

                // Walk backwards to find actual response element (skip feedback/UI elements)
                var responseEl = null;
                var skipPatterns = ['Feedback submitted', 'Was this response helpful'];
                for (var j = msgContainer.children.length - 1; j >= 0; j--) {
                  var child = msgContainer.children[j];
                  var txt = (child.innerText || '').trim();
                  if (txt.length < 10) continue;
                  var isUI = false;
                  for (var k = 0; k < skipPatterns.length; k++) {
                    if (txt.indexOf(skipPatterns[k]) >= 0 && txt.length < 200) { isUI = true; break; }
                  }
                  if (!isUI) { responseEl = child; break; }
                }
                if (responseEl && responseEl.innerHTML && responseEl.innerHTML.length > 20) {
                  console.log('__CAGENT_HTML__:' + responseEl.innerHTML);
                  var respText = (responseEl.innerText || '').trim();
                  if (respText.length > 3) {
                    console.log('__CAGENT_RESPONSE__:' + respText);
                  }
                }
              } catch(e) {}
            })();""".trimIndent()
            val cefFrameIface = Class.forName("org.cef.browser.CefFrame", true, jcefCL)
            val mainFrame = cefBrowserIface.getMethod("getMainFrame").invoke(cefBrowser)
            if (mainFrame != null) {
                val execMethod = cefFrameIface.getMethod(
                    "executeJavaScript", String::class.java, String::class.java, Int::class.javaPrimitiveType
                )
                execMethod.invoke(mainFrame, js, "about:blank", 0)
                if (pollCount <= 2) logger.info("JCEF: JS executed (console capture)")
            } else {
                if (pollCount <= 2) logger.info("JCEF: mainFrame is null")
            }
        } catch (e: Exception) {
            logger.warn("JCEF capture failed: ${e.message}")
        }
    }

    private fun stripHtml(html: String): String {
        var text = html
        text = text.replace(Regex("(?is)<script[^>]*>.*?</script>"), " ")
        text = text.replace(Regex("(?is)<style[^>]*>.*?</style>"), " ")
        text = text.replace(Regex("(?is)<noscript[^>]*>.*?</noscript>"), " ")
        text = text.replace(Regex("<br\\s*/?>", RegexOption.IGNORE_CASE), "\n")
        text = text.replace(Regex("</(?:p|div|h[1-6]|li|tr)>", RegexOption.IGNORE_CASE), "\n")
        text = text.replace(Regex("<[^>]+>"), " ")
        text = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
            .replace("&quot;", "\"").replace("&#39;", "'").replace("&nbsp;", " ")
        text = text.replace(Regex("[ \\t]+"), " ")
        text = text.replace(Regex("\\n{3,}"), "\n\n")
        return text.trim()
    }

    private fun pushOutput(sessionId: String, type: String, content: String, done: Boolean) {
        Thread {
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
                logger.info("Pushed output to API: type=$type, done=$done, length=${content.length}")
            } catch (e: Exception) {
                logger.debug("Failed to push output: ${e.message}")
            }
        }.start()
    }

    private fun clearRemoteOutput(sessionId: String) {
        Thread {
            val settings = SettingsService.getInstance()
            val request = Request.Builder()
                .url("${settings.state.apiBaseUrl}/api/commands/output?sessionId=$sessionId")
                .delete()
                .build()
            try {
                httpClient.newCall(request).execute().close()
            } catch (e: Exception) {
                logger.debug("Failed to clear output: ${e.message}")
            }
        }.start()
    }

    private fun attachToLanguageServerProcess() {
        if (processInterceptAttached) return
        try {
            val codeiumId = PluginId.getId("com.codeium.intellij")
            val descriptor = PluginManagerCore.getPlugin(codeiumId)
            if (descriptor == null) {
                logger.info("Process intercept: Codeium plugin not found")
                return
            }
            val cl = descriptor.pluginClassLoader ?: return

            tryFieldScanForProcessHandler(cl)

        } catch (e: Exception) {
            logger.info("Process intercept setup failed: ${e.message}")
        }
    }

    private fun findProcessHandlerInObject(obj: Any, maxDepth: Int, visited: MutableSet<Int>): ProcessHandler? {
        if (maxDepth <= 0) return null
        val id = System.identityHashCode(obj)
        if (id in visited) return null
        visited.add(id)
        if (obj is ProcessHandler) return obj

        if (obj is AtomicReference<*>) {
            val inner = obj.get()
            if (inner is ProcessHandler) return inner
            if (inner != null) return findProcessHandlerInObject(inner, maxDepth - 1, visited)
        }

        try {
            var clazz: Class<*>? = obj.javaClass
            while (clazz != null && clazz != Any::class.java) {
                for (field in clazz.declaredFields) {
                    if (field.type.isPrimitive || field.type == String::class.java
                        || field.type == Boolean::class.javaPrimitiveType
                        || field.type == Int::class.javaPrimitiveType
                        || field.type == Long::class.javaPrimitiveType
                    ) continue
                    try {
                        field.isAccessible = true
                        val value = field.get(obj) ?: continue
                        if (value is ProcessHandler) {
                            logger.info("Process intercept: found handler in ${clazz.name}.${field.name}")
                            return value
                        }
                        if (value is AtomicReference<*>) {
                            val inner = value.get()
                            if (inner is ProcessHandler) {
                                logger.info("Process intercept: found handler in AtomicRef ${clazz.name}.${field.name}")
                                return inner
                            }
                            if (inner != null && maxDepth > 1) {
                                val found = findProcessHandlerInObject(inner, maxDepth - 1, visited)
                                if (found != null) return found
                            }
                        }
                        if (maxDepth > 1
                            && !field.type.isArray
                            && !field.type.name.startsWith("java.lang.")
                            && !field.type.name.startsWith("kotlin.")
                            && !field.type.isEnum
                        ) {
                            val found = findProcessHandlerInObject(value, maxDepth - 1, visited)
                            if (found != null) return found
                        }
                    } catch (_: Exception) {}
                }
                clazz = clazz.superclass
            }
        } catch (_: Exception) {}
        return null
    }

    private fun tryFieldScanForProcessHandler(pluginCL: ClassLoader) {
        try {
            val handlerClass = Class.forName(
                "com.codeium.intellij.language_server.LanguageServerProcessHandler",
                true, pluginCL
            )
            logger.info("Process intercept: LanguageServerProcessHandler class loaded")

            val allFields = mutableListOf<String>()
            var c: Class<*>? = handlerClass
            while (c != null && c != Any::class.java) {
                for (field in c.declaredFields) {
                    val isStatic = java.lang.reflect.Modifier.isStatic(field.modifiers)
                    allFields.add("${if (isStatic) "static " else ""}${field.type.simpleName} ${field.name}")
                    if (isStatic) {
                        try {
                            field.isAccessible = true
                            val value = field.get(null)
                            if (value is ProcessHandler) {
                                logger.info("Process intercept: found static handler in ${field.name}")
                                attachProcessListener(value)
                                return
                            }
                        } catch (_: Exception) {}
                    }
                }
                c = c.superclass
            }
            logger.info("Process intercept: LanguageServerProcessHandler fields: ${allFields.joinToString(", ")}")

            if (ProcessHandler::class.java.isAssignableFrom(handlerClass)) {
                logger.info("Process intercept: LanguageServerProcessHandler IS a ProcessHandler subclass")
            }
        } catch (_: ClassNotFoundException) {
            logger.info("Process intercept: LanguageServerProcessHandler class not found")
        } catch (e: Exception) {
            logger.debug("Process intercept field scan failed: ${e.message}")
        }
    }

    private fun attachProcessListener(handler: ProcessHandler) {
        val adapter = object : ProcessListener {
            override fun onTextAvailable(event: ProcessEvent, outputType: Key<*>) {
                val text = event.text ?: return
                if (text.isBlank()) return
                synchronized(processOutputBuffer) {
                    processOutputBuffer.append(text)
                }
            }
        }
        try {
            handler.addProcessListener(adapter)
            interceptedHandler = handler
            processAdapter = adapter
            processInterceptAttached = true
            logger.info("Process intercept: attached listener to ${handler.javaClass.name}")
        } catch (e: Exception) {
            logger.warn("Process intercept: failed to attach listener: ${e.message}")
        }
    }

    private fun readProcessBuffer(): String? {
        if (!processInterceptAttached) return null
        val text: String
        synchronized(processOutputBuffer) {
            if (processOutputBuffer.isEmpty()) return null
            text = processOutputBuffer.toString()
            processOutputBuffer.clear()
        }
        return extractAgentResponseFromProcessOutput(text)
    }

    private fun extractAgentResponseFromProcessOutput(raw: String): String? {
        val sb = StringBuilder()
        for (line in raw.lines()) {
            val trimmed = line.trim()
            if (trimmed.isEmpty()) continue
            if (trimmed.startsWith("{") && trimmed.contains("\"jsonrpc\"")) {
                try {
                    val json = gson.fromJson(trimmed, JsonObject::class.java)
                    val params = json.getAsJsonObject("params")
                    if (params != null) {
                        val data = params.get("data")?.asString
                        if (data != null && data.length > 10
                            && !data.contains("MCP")
                            && !data.startsWith("[")
                            && !data.contains("readResponses")
                        ) {
                            sb.appendLine(data)
                        }
                    }
                } catch (_: Exception) {}
            } else if (trimmed.length > 20
                && !trimmed.startsWith("2026")
                && !trimmed.contains("INFO")
                && !trimmed.contains("DEBUG")
            ) {
                sb.appendLine(trimmed)
            }
        }
        val result = sb.toString().trim()
        return if (result.length > 10) result else null
    }

    private fun detachFromProcess() {
        try {
            val handler = interceptedHandler
            val adapter = processAdapter
            if (handler != null && adapter != null) {
                handler.removeProcessListener(adapter)
            }
        } catch (_: Exception) {}
        interceptedHandler = null
        processAdapter = null
        processInterceptAttached = false
        synchronized(processOutputBuffer) { processOutputBuffer.clear() }
    }
}
