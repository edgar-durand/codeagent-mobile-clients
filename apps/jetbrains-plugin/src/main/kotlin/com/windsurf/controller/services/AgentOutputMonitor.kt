package com.windsurf.controller.services

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.wm.ToolWindowManager
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.awt.Component
import java.awt.Container
import java.lang.ref.WeakReference
import java.util.Timer
import java.util.TimerTask
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import javax.accessibility.AccessibleContext
import javax.swing.SwingUtilities
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
    private val processTap = CodeiumProcessTap()
    private val jcefState = JcefCaptureState()
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
    private var currentPromptText: String = ""
    private var responseDoneSent: Boolean = false
    private var lastSentResponseText: String = ""
    /**
     * Opt-in flag set by {@link JetBrainsAIAssistantStrategy}. When
     * true, `captureToolWindowContent` also walks live `Editor` hosts
     * inside the tool window — needed for JetBrains AI Assistant
     * because its bubbles live inside `EditorComponentImpl`.
     */
    private var captureEmbeddedEditorEnabled: Boolean = false

    /**
     * Per-agent capture seam. Set by strategies that own a
     * {@link com.windsurf.controller.services.strategies.MessageExtractor}
     * (Copilot, AI Assistant, …). When non-null, `checkForChanges`
     * delegates the snapshot to the extractor and emits chunks based
     * on its result — no agent-specific code in this class. When null,
     * the legacy Swing/JCEF/accessibility scrape runs (Cascade /
     * Windsurf / Codeium and friends).
     */
    private var currentExtractor: com.windsurf.controller.services.strategies.MessageExtractor? = null
    private var extractorLastSentMarkdown: String = ""
    private var extractorStableCount: Int = 0

    companion object {
        private const val POLL_INTERVAL_MS = 2000L
        private const val STABLE_THRESHOLD = 3
        private const val MAX_EMPTY_POLLS = 15
        fun getInstance(): AgentOutputMonitor =
            ApplicationManager.getApplication().getService(AgentOutputMonitor::class.java)
    }

    /**
     * Begin polling the given tool window for response output.
     *
     * `captureEmbeddedEditor` opt-in: when true, after the standard
     * Swing scrape we also pull `editor.document.text` for every live
     * `EditorEx` hosted under the tool window. Required for the
     * JetBrains AI Assistant panel — its message bubbles render
     * inside `EditorComponentImpl`, which is NOT a `JTextComponent`,
     * so the standard Swing scrape misses them. Other strategies pass
     * `false` so their behaviour is identical to the pre-strategy
     * implementation.
     */
    fun startMonitoring(
        sessionId: String,
        toolWindowId: String,
        promptText: String,
        captureEmbeddedEditor: Boolean = false,
        extractor: com.windsurf.controller.services.strategies.MessageExtractor? = null,
    ) {
        stopMonitoring()

        currentSessionId = sessionId
        currentToolWindowId = toolWindowId
        currentPromptText = promptText.trim()
        captureEmbeddedEditorEnabled = captureEmbeddedEditor
        currentExtractor = extractor
        extractorLastSentMarkdown = ""
        extractorStableCount = 0
        projectRef = WeakReference(
            ProjectManager.getInstance().openProjects.firstOrNull()
        )
        isMonitoring = true
        stableCount = 0
        pollCount = 0
        hasEverCapturedContent = false
        responseDoneSent = false
        lastSentResponseText = ""
        jcefState.resetSnapshotsForNewTurn()

        processTap.attach()

        previousSnapshot = captureToolWindowContent() ?: ""
        logger.info("Output monitoring started for session=$sessionId, toolWindow=$toolWindowId, baselineLength=${previousSnapshot.length}")

        // Per-turn reset: extractors need to know "everything visible
        // right now is the previous turn — the response to the current
        // prompt will materialise after this point". Without this hook
        // Copilot's extractor reports the previous turn's bubble while
        // the new bubble is still mounting, causing the mobile UI to
        // see "previous response + current response" concatenated.
        if (extractor != null) {
            try {
                val project = projectRef?.get()
                val tw = if (project != null) ToolWindowManager.getInstance(project).getToolWindow(toolWindowId) else null
                if (tw != null) extractor.resetForNewTurn(tw)
            } catch (e: Exception) {
                logger.debug("Extractor resetForNewTurn failed: ${e.message}")
            }
        }

        AgentOutputPublisher.clearRemoteOutput(sessionId)

        // Tell the mobile/web client that a new turn is starting so it
        // creates a fresh agent bubble instead of appending to the
        // previous one. The legacy non-extractor path emits this when
        // it detects activity after a `done`, but extractor-driven
        // turns may emit `text/done=true` on their very first poll
        // (Copilot finishes a short reply before our 500 ms tick), so
        // we have to issue the signal up front — otherwise mobile
        // treats the new chunk as a continuation of the old bubble
        // and the user sees "previous response + current response".
        AgentOutputPublisher.pushOutput(sessionId, "new_turn", "", done = false)

        // Extractor-driven agents poll a small, scoped subtree (one
        // assistant bubble for Copilot, the Compose accessibility tree
        // for AI Assistant), so we can afford a faster cadence — 500 ms
        // feels close to CLI streaming. Legacy scrape-based agents use
        // the original 2 s cadence.
        val intervalMs = if (extractor != null) 500L else POLL_INTERVAL_MS
        monitorTimer = Timer("agent-output-monitor", true).apply {
            scheduleAtFixedRate(object : TimerTask() {
                override fun run() {
                    checkForChanges()
                }
            }, intervalMs, intervalMs)
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
        captureEmbeddedEditorEnabled = false
        currentExtractor = null
        extractorLastSentMarkdown = ""
        extractorStableCount = 0
        processTap.detach()
        jcefState.stop()
        logger.info("Output monitoring stopped")
    }

    fun isActive(): Boolean = isMonitoring

    private fun checkForChanges() {
        if (!isMonitoring) return

        val sessionId = currentSessionId ?: return
        pollCount++

        // Per-agent capture seam: when a strategy registered an
        // extractor, delegate the snapshot to it and emit chunks
        // generically. No agent-specific code lives in this class.
        val extractor = currentExtractor
        if (extractor != null) {
            handleExtractorPoll(sessionId, extractor)
            return
        }

        val currentContent = captureToolWindowContent() ?: ""

        if (currentContent == previousSnapshot) {
            stableCount++

            if (!hasEverCapturedContent && pollCount >= MAX_EMPTY_POLLS) {
                logger.warn("No content captured after $MAX_EMPTY_POLLS polls, stopping monitor")
                AgentOutputPublisher.pushOutput(sessionId, "status", "Could not capture agent response. The AI panel may use an unsupported renderer.", done = true)
                stopMonitoring()
                return
            }

            val threshold = if (hasEverCapturedContent) STABLE_THRESHOLD else STABLE_THRESHOLD * 3
            if (stableCount >= threshold && hasEverCapturedContent && !responseDoneSent) {
                logger.info("Agent output stabilized after ${stableCount * POLL_INTERVAL_MS}ms")
                // Send HTML with done=true to avoid race condition (single atomic chunk)
                val html = jcefState.consumeHtml()
                if (html != null && html.length > 20) {
                    val cleanHtml = AgentOutputTextUtils.stripTailwindClasses(html)
                    logger.info("Sending final HTML (${cleanHtml.length} chars)")
                    AgentOutputPublisher.pushOutput(sessionId, "html", cleanHtml, done = true)
                } else {
                    AgentOutputPublisher.pushOutput(sessionId, "status", "", done = true)
                }
                // Don't stop monitoring — keep watching for new activity from IDE
                responseDoneSent = true
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
            AgentOutputPublisher.clearRemoteOutput(sessionId)
            AgentOutputPublisher.pushOutput(sessionId, "new_turn", "", done = false)
        }

        // Prefer clean response text from JCEF element, fall back to page extraction
        val jcefResponse = jcefState.consumeResponseText()
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
            AgentOutputPublisher.pushOutput(sessionId, "text", responseSnapshot, done = false)
        }
    }

    private fun extractResponseSnapshot(currentSnapshot: String): String {
        val cleanText = AgentOutputTextUtils.cleanCapturedText(currentSnapshot)
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
                    AgentOutputCaptureHelpers.collectSwingText(component, textParts, componentTypes)
                }

                if (pollCount <= 2 && componentTypes.isNotEmpty()) {
                    logger.info("Tool window component types: ${componentTypes.joinToString(", ")}")
                }

                // Opt-in pass for tool windows that render message
                // bubbles inside `EditorComponentImpl` (JetBrains AI
                // Assistant, PR AI Assistant). Strategies that need it
                // call `startMonitoring(..., captureEmbeddedEditor = true)`;
                // every other strategy sees no behavioural change.
                if (captureEmbeddedEditorEnabled) {
                    for (c in content) {
                        val component = c.component ?: continue
                        AgentOutputCaptureHelpers.collectEmbeddedEditorText(component, textParts, componentTypes)
                    }
                }

                if (textParts.isNotEmpty()) {
                    result.set(textParts.joinToString("\n"))
                } else {
                    for (c in content) {
                        val component = c.component ?: continue
                        val browser = AgentOutputCaptureHelpers.findJBCefBrowser(component)
                        if (browser != null) {
                            jcefState.setupCapture(browser)
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
            val text = jcefState.awaitText(3, TimeUnit.SECONDS)
            if (text != null) {
                logStrategy("jcef-console")
                return text
            }
            if (pollCount <= 3) logger.debug("JCEF HTTP callback timed out after 3s")
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

        val processText = processTap.readBuffer()
        if (processText != null) {
            logStrategy("process-intercept")
            return processText
        }

        return null
    }

    @Volatile private var lastCaptureStrategy: String = "none"

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
                    AgentOutputCaptureHelpers.collectAccessibleText(component, sb, 0)
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

    // ---------------------------------------------------------------
    // Generic extractor-driven poll
    // ---------------------------------------------------------------
    //
    // The polling loop, dedup state, push protocol, and turn lifecycle
    // live here. The agent-specific knowledge (where the bubbles are,
    // how to convert them to markdown, how to detect "done") lives in
    // each strategy's MessageExtractor. That keeps this class agnostic
    // of any one agent and lets us add new providers by writing a new
    // extractor — no edits to AgentOutputMonitor.

    private fun handleExtractorPoll(
        sessionId: String,
        extractor: com.windsurf.controller.services.strategies.MessageExtractor,
    ) {
        val project = projectRef?.get() ?: return
        val twId = currentToolWindowId ?: return
        val twRef = AtomicReference<com.intellij.openapi.wm.ToolWindow?>(null)
        val app = ApplicationManager.getApplication()
        val twTask = Runnable {
            twRef.set(ToolWindowManager.getInstance(project).getToolWindow(twId))
        }
        if (app.isDispatchThread) twTask.run() else {
            try { app.invokeAndWait(twTask) } catch (_: Exception) {}
        }
        val tw = twRef.get() ?: return

        val msg = try {
            extractor.extract(project, tw, currentPromptText)
        } catch (e: Exception) {
            logger.debug("Extractor threw: ${e.message}")
            null
        }

        if (msg == null) {
            if (!hasEverCapturedContent && pollCount >= MAX_EMPTY_POLLS) {
                logger.warn("No message captured after $MAX_EMPTY_POLLS polls (extractor=${extractor.javaClass.simpleName})")
                AgentOutputPublisher.pushOutput(sessionId, "status", "Could not capture agent response.", done = true)
                stopMonitoring()
            }
            return
        }

        val md = msg.markdown
        if (md.isBlank()) return

        // Explicit done signal from the extractor (e.g. Copilot's
        // "Completed" pill). Always emit a final chunk so the mobile
        // UI's streaming indicator closes immediately. Prefer the
        // extractor's canonical-final markdown if it provides one.
        if (msg.isDone == true) {
            if (!responseDoneSent) {
                val canonical = finalizeMarkdown(extractor, project, tw, md)
                extractorLastSentMarkdown = canonical
                hasEverCapturedContent = true
                responseDoneSent = true
                AgentOutputPublisher.pushOutput(sessionId, "text", canonical, done = true)
                logger.info("Extractor done (explicit): emitted final chunk (${canonical.length} chars, canonical=${canonical !== md})")
            }
            return
        }

        if (md == extractorLastSentMarkdown) {
            // Content unchanged. If the extractor can't tell us when
            // generation finishes (isDone == null), fall back to the
            // stability heuristic: emit a final chunk after the response
            // has been steady for STABLE_THRESHOLD polls. Prefer the
            // extractor's canonical-final markdown if it provides one —
            // streaming chunks may have come from a flattening path
            // (accessibility tree → tables as one cell per line, code
            // blocks without fences), and finalize() typically reads
            // the live ChatSession's MarkdownChatMessage which carries
            // the canonical markdown the chat panel renders.
            if (msg.isDone == null && hasEverCapturedContent && !responseDoneSent) {
                extractorStableCount++
                if (extractorStableCount >= STABLE_THRESHOLD) {
                    responseDoneSent = true
                    val canonical = finalizeMarkdown(extractor, project, tw, md)
                    extractorLastSentMarkdown = canonical
                    AgentOutputPublisher.pushOutput(sessionId, "text", canonical, done = true)
                    logger.info("Extractor done (stability): emitted final chunk (${canonical.length} chars, canonical=${canonical !== md})")
                }
            }
            return
        }

        // Content changed — reset stability counter and emit a delta.
        extractorStableCount = 0
        if (responseDoneSent) {
            // A new turn started after a previously-completed reply.
            // Reset the chunk pipeline before emitting the first delta.
            responseDoneSent = false
            extractorLastSentMarkdown = ""
            AgentOutputPublisher.clearRemoteOutput(sessionId)
        }
        extractorLastSentMarkdown = md
        hasEverCapturedContent = true
        AgentOutputPublisher.pushOutput(sessionId, "text", md, done = false)
    }

    /**
     * Ask the extractor for its canonical-final markdown payload, with
     * graceful fall-back to the last streaming snapshot.
     *
     * Streaming chunks for AI Assistant come from a Swing /
     * accessibility-tree scrape that flattens structure: code blocks
     * lose their fences, tables emit one cell per line, lists merge
     * into one paragraph. `finalize()` lets the extractor pull the
     * canonical markdown out of the agent's model object (for AI
     * Assistant, `MarkdownChatMessage.getDisplayText()` via the bridge),
     * so the final chunk the mobile renders has tables / code / lists
     * intact.
     *
     * Returns the canonical markdown if finalize produces a non-blank
     * result that is at least as long as the streaming snapshot (guard
     * against a getter that returns a UID or some other short string —
     * we'd rather show flattened-but-complete than short-but-empty).
     * Otherwise returns the streaming snapshot unchanged.
     */
    private fun finalizeMarkdown(
        extractor: com.windsurf.controller.services.strategies.MessageExtractor,
        project: Project,
        tw: com.intellij.openapi.wm.ToolWindow,
        streamingMarkdown: String,
    ): String {
        return try {
            val canonical = extractor.finalize(project, tw, currentPromptText)
            // The extractor's heuristic already rejects non-markdown
            // strings (returns null for things like UIDs / labels).
            // We only need to gate on null/blank here.
            if (canonical.isNullOrBlank()) streamingMarkdown else canonical
        } catch (e: Exception) {
            logger.debug("Extractor finalize threw: ${e.message}")
            streamingMarkdown
        }
    }


}
