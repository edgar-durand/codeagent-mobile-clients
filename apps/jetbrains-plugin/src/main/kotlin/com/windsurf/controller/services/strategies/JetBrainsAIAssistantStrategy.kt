package com.windsurf.controller.services.strategies

import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.actionSystem.ex.ActionUtil
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.wm.ToolWindow
import com.windsurf.controller.services.AgentOutputMonitor
import com.windsurf.controller.services.DetectedAgent
import com.windsurf.controller.services.IdeIntegrationService
import java.awt.Component
import java.awt.Container
import java.awt.datatransfer.StringSelection
import java.awt.event.KeyEvent
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import javax.swing.AbstractButton
import javax.swing.text.JTextComponent

/**
 * JetBrains AI Assistant — the bundled AI Chat ("AIAssistant" tool
 * window, plugin id `com.intellij.ml.llm`).
 *
 * **Sending side (this file):** the input field is a Swing
 * `AIAssistantInputEditorTextField`. The send button is an
 * `ActionButton` whose action class ends in `AIAssistantInputSendAction`.
 * Both live above the Compose surface that renders the bubbles, so
 * Swing-direct injection works for input even though output capture
 * needs the Compose path. As a last resort we invoke the action by id
 * (`AIAssistant.Chat.SendActions.Send`) via `ActionUtil.invokeAction`,
 * which works even if the button hasn't materialised yet.
 *
 * **Receiving side ({@link AIAssistantMessageExtractor}):** recent
 * versions render the conversation inside Jetpack Compose
 * (`JewelComposePanelWrapper` → `ComposePanel` → Skia surface), so the
 * earlier `captureEmbeddedEditor` Swing-walk only ever found the input
 * field. The Compose-aware extractor walks the panel's `AccessibleContext`
 * tree (the only surface that exposes Compose semantics text), strips
 * the user's own prompt, and emits incremental `text` chunks.
 *
 * Diagnosed against WebStorm 2026.1 + JetBrains AI Assistant +
 * Codex (May 2026).
 */
class JetBrainsAIAssistantStrategy : AgentStrategy {
    override val name: String = "JetBrains AI Assistant"
    private val logger = Logger.getInstance(JetBrainsAIAssistantStrategy::class.java)

    override fun canHandle(agent: DetectedAgent?): Boolean {
        if (agent == null) return false
        val pid = agent.pluginId.lowercase()
        if (pid == "com.intellij.ml.llm" || pid == "com.intellij.ai") return true
        val tw = agent.toolWindowId.lowercase()
        return tw == "aiassistant" || tw == "ai assistant" || tw == "jetbrains ai assistant"
    }

    override fun deliverPrompt(invocation: AgentInvocation): Boolean {
        val ide = IdeIntegrationService.getInstance()
        val agents = ide.detectInstalledAgents()
        val app = ApplicationManager.getApplication()

        val twRef = AtomicReference<ToolWindow?>(null)
        val findTask = Runnable {
            twRef.set(ide.findToolWindow(invocation.project, invocation.agent, agents))
        }
        if (app.isDispatchThread) findTask.run() else try {
            app.invokeAndWait(findTask)
        } catch (e: Exception) {
            logger.warn("AI Assistant deliverPrompt: invokeAndWait(find) failed: ${e.message}")
        }

        val tw = twRef.get()
        if (tw == null) {
            CopyPasteManager.getInstance().setContents(StringSelection(invocation.prompt))
            ide.showNotification("Prompt copied to clipboard (AI Assistant not found)", invocation.prompt)
            return false
        }

        // Show + activate. Use the no-callback variant (the callback
        // overload proved unreliable). On non-EDT we sleep 1.5 s so
        // IntelliJ's render loop can mount the chat panel before we
        // walk for the input. On EDT we skip the sleep — blocking
        // the render loop here would *prevent* mounting.
        val activateTask = Runnable {
            try {
                tw.show()
                tw.activate(null)
            } catch (e: Exception) {
                logger.warn("AI Assistant deliverPrompt: activate threw: ${e.message}")
            }
        }
        if (app.isDispatchThread) {
            activateTask.run()
        } else {
            try { app.invokeAndWait(activateTask) } catch (_: Exception) {}
            try { Thread.sleep(1500) } catch (_: InterruptedException) { return false }
        }

        // Primary path — AI Assistant's own input + send action.
        // Replaces the document directly (not setText, which on
        // AIAssistantInputEditorTextField appends instead of replacing
        // and produced "holahola..."), then invokes
        // AIAssistant.Chat.SendActions.Send by id.
        if (AIAssistantBridge.submit(invocation.project, invocation.prompt, tw)) {
            logger.info("AI Assistant: dispatched via AIAssistantBridge")
            ide.showNotification("Prompt sent to AI Assistant", invocation.prompt)
            return true
        }
        logger.info("AI Assistant: bridge unavailable — falling back to Swing-direct")

        if (trySwingAIAssistantPromptInjection(tw, invocation.prompt, maxWaitMs = 3000L)) {
            ide.showNotification("Prompt sent to AI Assistant", invocation.prompt)
            return true
        }
        logger.warn("AI Assistant Swing injection failed; falling back to Robot")

        // Clear the input first so Robot Cmd+V doesn't append to the
        // setText'd content and produce duplicated text.
        val cleanupTask = Runnable {
            detectSwingChatTarget(tw)?.input?.let { it.text = "" }
        }
        if (app.isDispatchThread) cleanupTask.run() else try {
            app.invokeAndWait(cleanupTask)
        } catch (_: Exception) {}

        CopyPasteManager.getInstance().setContents(StringSelection(invocation.prompt))
        app.invokeLater {
            Thread.sleep(800)
            ide.simulatePasteAndSubmit()
        }
        ide.showNotification("Prompt sent to AI Assistant", invocation.prompt)
        return true
    }

    override fun execute(invocation: AgentInvocation): Boolean {
        if (!deliverPrompt(invocation)) return false
        val twId = invocation.agent?.toolWindowId ?: return true
        AgentOutputMonitor.getInstance().startMonitoring(
            sessionId = invocation.sessionId,
            toolWindowId = twId,
            promptText = invocation.prompt,
            extractor = AIAssistantMessageExtractor(),
        )
        logger.info("Started AI Assistant monitor on toolWindow=$twId")
        return true
    }

    override fun stop() {
        AgentOutputMonitor.getInstance().stopMonitoring()
    }

    /**
     * Verify-on-clear with realistic timeout. See CopilotChatStrategy
     * for the design rationale: the click may target a non-send
     * button (dropdown / model picker), so we must verify the input
     * cleared before declaring success. If the click didn't submit,
     * we try dispatching Enter; if that doesn't either, we retry.
     */
    private fun trySwingAIAssistantPromptInjection(
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
                    val (attempted, input) = performAIAssistantSwingInjection(tw, prompt)
                    sentRef.set(attempted)
                    attemptedRef.set(input)
                } catch (e: Exception) {
                    logger.debug("AI Assistant Swing injection iteration failed: ${e.message}")
                }
            }
            if (app.isDispatchThread) task.run() else {
                try { app.invokeAndWait(task) } catch (_: Exception) {}
            }

            val input = attemptedRef.get()
            if (sentRef.get() && input != null) {
                if (waitForCleared(input, prompt, 2500L)) return true
                logger.warn("AI Assistant Swing: click did not clear input; dispatching Enter")
                dispatchEnterOnEdt(input)
                if (waitForCleared(input, prompt, 1500L)) return true
                clearOnEdt(input)
                logger.info("AI Assistant Swing: neither click nor Enter submitted — retrying")
            }
            try { Thread.sleep(150) } catch (_: InterruptedException) { return false }
        }
        return false
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
                try { app.invokeAndWait(task) } catch (_: Exception) {}
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
            try { app.invokeAndWait(task) } catch (_: Exception) {}
        }
    }

    private fun clearOnEdt(input: JTextComponent) {
        val app = ApplicationManager.getApplication()
        val task = Runnable { input.text = "" }
        if (app.isDispatchThread) task.run() else {
            try { app.invokeAndWait(task) } catch (_: Exception) {}
        }
    }

    /**
     * Generic Swing chat-input discovery — does NOT rely on AI
     * Assistant's specific class names. Picks the bottom-most editable
     * `JTextComponent` (chat inputs are at the bottom) and the visible
     * `AbstractButton` closest to it on screen. Falls back to the
     * `AIAssistant.Chat.SendActions.Send` action id when no button
     * sits near the input — that action exists across recent
     * AI Assistant builds and bypasses the need to find a Swing button
     * widget at all (useful when the send button is rendered by
     * Compose Desktop and is not present in the Swing tree).
     */
    private fun performAIAssistantSwingInjection(
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
            logger.info("AI Assistant Swing injection: setText + clicked ${sendButton.javaClass.simpleName} tooltip='${sendButton.toolTipText}'")
            return true to input
        }

        // No confidently-scored button. Try the well-known action id
        // (works across AI Assistant versions, including when the send
        // widget is rendered by Compose Desktop and therefore absent
        // from the Swing tree).
        if (invokeAIAssistantSendAction()) {
            logger.info("AI Assistant Swing injection: setText + invoked AIAssistant.Chat.SendActions.Send")
            return true to input
        }

        // Last-resort: dispatch Enter on the input.
        val pressed = KeyEvent(input, KeyEvent.KEY_PRESSED, System.currentTimeMillis(), 0, KeyEvent.VK_ENTER, '\n')
        input.dispatchEvent(pressed)
        val released = KeyEvent(input, KeyEvent.KEY_RELEASED, System.currentTimeMillis(), 0, KeyEvent.VK_ENTER, '\n')
        input.dispatchEvent(released)
        logger.info("AI Assistant Swing injection: no scored send button, dispatched Enter on input")
        return true to input
    }

    private fun invokeAIAssistantSendAction(): Boolean {
        return try {
            val mgr = ActionManager.getInstance()
            val action = mgr.getAction("AIAssistant.Chat.SendActions.Send") ?: return false
            val dataContext = DataContext { _ -> null }
            ActionUtil.invokeAction(
                action,
                dataContext,
                "CodeAgentMobile.AIAssistantSend",
                null,
                null,
            )
            true
        } catch (e: Exception) {
            logger.debug("ActionUtil.invokeAction(AIAssistant.Chat.SendActions.Send) failed: ${e.message}")
            false
        }
    }
}
