package com.windsurf.controller.services.strategies

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.wm.ToolWindow
import com.intellij.util.concurrency.AppExecutorUtil
import com.windsurf.controller.services.AgentOutputMonitor
import com.windsurf.controller.services.DetectedAgent
import com.windsurf.controller.services.IdeIntegrationService
import com.windsurf.controller.ui.BrandMessages
import java.awt.Component
import java.awt.datatransfer.StringSelection
import java.awt.event.KeyEvent
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import javax.swing.text.JTextComponent

/**
 * GitHub Copilot Chat. Two delivery paths, in priority order:
 *
 * 1. **`CopilotChatBridge`** — calls Copilot's internal
 *    `com.github.copilot.api.CopilotChatService.query(...)` via
 *    reflection. This is the same code path the user takes when they
 *    type into the chat and click Send: it opens the tool window,
 *    submits the prompt, and emits a done callback. Doesn't need OS
 *    focus, doesn't depend on Compose/Swing internals. Verified
 *    against `github-copilot-intellij` 1.9.0-251.
 * 2. **Swing-direct + JCEF + Robot Cmd+V fallback** — only runs when
 *    the bridge can't reach Copilot's API (older plugin version, API
 *    package renamed, etc.). Tries to find the chat input by walking
 *    `tw.component`'s descendants, set its text, and click the
 *    scored "Send" button; if that doesn't submit, dispatch Enter on
 *    the input; if that fails too, clipboard + Robot Cmd+V on whatever
 *    has OS focus.
 *
 * The output side (capturing the assistant's reply) is unchanged —
 * `CopilotMessageExtractor` walks `CopilotAgentMessageComponent`
 * bubbles. The mobile renderer gets the same markdown as before.
 */
class CopilotChatStrategy : AgentStrategy {
    override val name: String = "GitHub Copilot Chat"
    private val logger = Logger.getInstance(CopilotChatStrategy::class.java)

    override fun canHandle(agent: DetectedAgent?): Boolean {
        if (agent == null) return false
        if (agent.pluginId.equals("com.github.copilot", ignoreCase = true)) return true
        val tw = agent.toolWindowId.lowercase()
        return tw == "github copilot chat" || tw == "copilot chat"
    }

    override fun deliverPrompt(invocation: AgentInvocation): Boolean {
        val ide = IdeIntegrationService.getInstance()

        // Primary path — Copilot's own internal API. We attach
        // onError + onComplete to capture quota / rate-limit messages
        // so mobile/web can show the same banner the CLI shows for
        // Claude. CopilotChatBridge.lastQuotaError is read later by
        // the metadata bridge and forwarded as `rateLimitReset` in
        // the get_context payload.
        val dispatched = CopilotChatBridge.submit(
            project = invocation.project,
            prompt = invocation.prompt,
            onAssistantDone = { CopilotChatBridge.lastQuotaError = null },
            onError = { msg ->
                if (CopilotChatBridge.looksLikeQuotaError(msg)) {
                    CopilotChatBridge.lastQuotaError = msg
                    logger.warn("Copilot quota error captured: $msg")
                }
            },
        )
        if (dispatched) {
            logger.info("Copilot: dispatched via CopilotChatService")
            ide.showNotification("Prompt sent to Copilot Chat", invocation.prompt)
            return true
        }

        // Fallback for older / patched Copilot builds where the
        // internal API isn't reachable. Activate the tool window,
        // try Swing-direct, then JCEF, then Robot Cmd+V.
        return deliverPromptFallback(invocation, ide)
    }

    private fun deliverPromptFallback(
        invocation: AgentInvocation,
        ide: IdeIntegrationService,
    ): Boolean {
        val app = ApplicationManager.getApplication()
        val agents = ide.detectInstalledAgents()

        val twRef = AtomicReference<ToolWindow?>(null)
        val findTask = Runnable {
            twRef.set(ide.findToolWindow(invocation.project, invocation.agent, agents))
        }
        if (app.isDispatchThread) findTask.run() else try {
            app.invokeAndWait(findTask)
        } catch (e: Exception) { logger.trace(e) }

        val tw = twRef.get()
        if (tw == null) {
            CopyPasteManager.getInstance().setContents(StringSelection(invocation.prompt))
            ide.showNotification(BrandMessages.promptCopiedToClipboard("Copilot Chat not detected"), invocation.prompt)
            return false
        }

        // Show + activate, then yield off-EDT so the render loop can
        // mount the chat panel children before we walk for the input.
        val activateTask = Runnable {
            try {
                tw.show()
                tw.activate(null)
            } catch (e: Exception) { logger.trace(e) }
        }
        if (app.isDispatchThread) {
            activateTask.run()
        } else {
            try { app.invokeAndWait(activateTask) } catch (e: Exception) { logger.trace(e) }
            try { Thread.sleep(1500) } catch (_: InterruptedException) { return false }
        }

        // Find a JCEF browser if Copilot ever renders chat in Chromium.
        val jcefRef = AtomicReference<Any?>(null)
        val findJcefTask = Runnable {
            val contents = tw.contentManager.contents
            val roots: List<Component> = if (contents.isNotEmpty()) {
                contents.map { it.component }
            } else {
                listOfNotNull(tw.component)
            }
            for (root in roots) {
                val browser = ide.findJBCefBrowser(root)
                if (browser != null) {
                    jcefRef.set(browser)
                    break
                }
            }
        }
        if (app.isDispatchThread) findJcefTask.run() else try {
            app.invokeAndWait(findJcefTask)
        } catch (e: Exception) { logger.trace(e) }

        if (trySwingCopilotPromptInjection(tw, invocation.prompt, maxWaitMs = 3000L)) {
            ide.showNotification("Prompt sent to Copilot Chat", invocation.prompt)
            return true
        }

        val browser = jcefRef.get()
        if (browser != null && ide.executeJcefPromptInjection(browser, invocation.prompt)) {
            ide.showNotification("Prompt sent to Copilot Chat", invocation.prompt)
            return true
        }

        // Last resort: Robot Cmd+V on whatever has OS focus. Wipe any
        // residual setText from the Swing path first so the paste
        // doesn't append (`hola` + paste `hola` → `holahola`).
        val cleanupTask = Runnable {
            detectSwingChatTarget(tw)?.input?.let { it.text = "" }
        }
        if (app.isDispatchThread) cleanupTask.run() else try {
            app.invokeAndWait(cleanupTask)
        } catch (e: Exception) { logger.trace(e) }

        CopyPasteManager.getInstance().setContents(StringSelection(invocation.prompt))
        // Delay off-EDT, then hop back — a Thread.sleep inside
        // invokeLater would block the Swing EDT (painting + input)
        // for the whole 800 ms.
        AppExecutorUtil.getAppScheduledExecutorService().schedule({
            app.invokeLater { ide.simulatePasteAndSubmit() }
        }, 800, TimeUnit.MILLISECONDS)
        ide.showNotification("Prompt sent to Copilot Chat", invocation.prompt)
        return true
    }

    override fun execute(invocation: AgentInvocation): Boolean {
        if (!deliverPrompt(invocation)) return false
        val twId = invocation.agent?.toolWindowId ?: return true
        AgentOutputMonitor.getInstance()
            .startMonitoring(
                sessionId = invocation.sessionId,
                toolWindowId = twId,
                promptText = invocation.prompt,
                extractor = CopilotMessageExtractor(),
            )
        return true
    }

    override fun stop() {
        AgentOutputMonitor.getInstance().stopMonitoring()
    }

    /**
     * Swing-direct attempt with verify-on-clear. Returns `true` only
     * when Copilot's input field actually clears after the click —
     * that's the one reliable signal that the message reached
     * Copilot's backend. If it doesn't clear we dispatch Enter on the
     * input and re-verify. Used only by the fallback path.
     */
    private fun trySwingCopilotPromptInjection(
        tw: ToolWindow,
        prompt: String,
        maxWaitMs: Long,
    ): Boolean {
        val app = ApplicationManager.getApplication()
        val deadline = System.currentTimeMillis() + maxWaitMs
        while (System.currentTimeMillis() < deadline) {
            val sentRef = AtomicBoolean(false)
            val attemptedRef = AtomicReference<JTextComponent?>(null)
            val task = Runnable {
                try {
                    val (attempted, input) = performCopilotSwingInjection(tw, prompt)
                    sentRef.set(attempted)
                    attemptedRef.set(input)
                } catch (e: Exception) { logger.trace(e) }
            }
            if (app.isDispatchThread) task.run() else {
                try { app.invokeAndWait(task) } catch (e: Exception) { logger.trace(e) }
            }

            val input = attemptedRef.get()
            if (sentRef.get() && input != null) {
                if (waitForCleared(input, prompt, 2500L)) return true
                dispatchEnterOnEdt(input)
                if (waitForCleared(input, prompt, 1500L)) return true
                clearOnEdt(input)
            }
            try { Thread.sleep(150) } catch (_: InterruptedException) { return false }
        }
        return false
    }

    private fun performCopilotSwingInjection(
        tw: ToolWindow,
        prompt: String,
    ): Pair<Boolean, JTextComponent?> {
        val target = detectSwingChatTarget(tw) ?: return false to null
        val input = target.input

        input.text = prompt
        input.caretPosition = prompt.length
        input.requestFocusInWindow()

        val sendButton = target.sendButton
        if (sendButton != null) {
            sendButton.doClick()
            return true to input
        }
        // No confidently-scored button — dispatch Enter on the input.
        val pressed = KeyEvent(input, KeyEvent.KEY_PRESSED, System.currentTimeMillis(), 0, KeyEvent.VK_ENTER, '\n')
        input.dispatchEvent(pressed)
        val released = KeyEvent(input, KeyEvent.KEY_RELEASED, System.currentTimeMillis(), 0, KeyEvent.VK_ENTER, '\n')
        input.dispatchEvent(released)
        return true to input
    }

    private fun waitForCleared(input: JTextComponent, prompt: String, timeoutMs: Long): Boolean {
        val app = ApplicationManager.getApplication()
        val expected = prompt.trim()
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val cleared = AtomicBoolean(false)
            val task = Runnable {
                val current = (input.text ?: "").trim()
                cleared.set(current != expected)
            }
            if (app.isDispatchThread) task.run() else {
                try { app.invokeAndWait(task) } catch (e: Exception) { logger.trace(e) }
            }
            if (cleared.get()) return true
            try { Thread.sleep(100) } catch (_: InterruptedException) { return false }
        }
        return false
    }

    private fun dispatchEnterOnEdt(input: JTextComponent) {
        val app = ApplicationManager.getApplication()
        val task = Runnable {
            val pressed = KeyEvent(input, KeyEvent.KEY_PRESSED, System.currentTimeMillis(), 0, KeyEvent.VK_ENTER, '\n')
            input.dispatchEvent(pressed)
            val released = KeyEvent(input, KeyEvent.KEY_RELEASED, System.currentTimeMillis(), 0, KeyEvent.VK_ENTER, '\n')
            input.dispatchEvent(released)
        }
        if (app.isDispatchThread) task.run() else {
            try { app.invokeAndWait(task) } catch (e: Exception) { logger.trace(e) }
        }
    }

    private fun clearOnEdt(input: JTextComponent) {
        val app = ApplicationManager.getApplication()
        val task = Runnable { input.text = "" }
        if (app.isDispatchThread) task.run() else {
            try { app.invokeAndWait(task) } catch (e: Exception) { logger.trace(e) }
        }
    }
}
