package com.windsurf.controller.services.strategies

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.util.SystemInfo
import com.windsurf.controller.services.DetectedAgent
import com.windsurf.controller.services.IdeIntegrationService
import java.awt.Robot
import java.awt.datatransfer.StringSelection
import java.awt.event.KeyEvent

/**
 * Manual-handoff strategy: puts the prompt on the clipboard and
 * simulates `Cmd+V` (or `Ctrl+V` on non-Mac) followed by Enter, against
 * **whatever currently has OS-level focus**.
 *
 * **Why this exists as an opt-in strategy and NOT as an automatic
 * fallback:** when Robot paste fires while a terminal has focus the
 * prompt gets executed as a shell command — exactly what happened in
 * the WebStorm 2026.1 + Copilot regression on May 10. So this code is
 * preserved as its own self-contained unit (each agent's send logic
 * lives in its own strategy, including this one) but `canHandle` only
 * claims agents whose `id` starts with the explicit `__robot_paste__:`
 * prefix. Until something programmatically invokes a synthetic
 * `DetectedAgent` with that prefix — e.g. a future "Force Robot paste"
 * UI escape hatch — this strategy is dormant.
 *
 * Don't reintroduce it as an automatic last resort in any other
 * strategy. If Swing-direct and JCEF both fail, the safe behaviour is
 * clipboard + notification, not blind paste.
 */
class RobotPasteStrategy : AgentStrategy {
    override val name: String = "Robot paste (manual handoff)"
    private val logger = Logger.getInstance(RobotPasteStrategy::class.java)

    override fun canHandle(agent: DetectedAgent?): Boolean {
        if (agent == null) return false
        return agent.id.startsWith("__robot_paste__:")
    }

    override fun deliverPrompt(invocation: AgentInvocation): Boolean {
        // Place the prompt on the clipboard first so the OS paste reads it.
        CopyPasteManager.getInstance().setContents(StringSelection(invocation.prompt))

        val app = ApplicationManager.getApplication()
        app.invokeLater {
            try {
                // Small delay to let the OS settle focus on whichever window
                // the user (or a programmatic activation) made foreground.
                Thread.sleep(800)
                simulatePasteAndSubmit()
            } catch (e: Exception) {
                logger.warn("Robot paste failed: ${e.message}")
            }
        }
        IdeIntegrationService.getInstance().showNotification(
            "Prompt sent via Robot paste",
            invocation.prompt,
        )
        return true
    }

    override fun execute(invocation: AgentInvocation): Boolean {
        // Robot-handoff is fire-and-forget — there is no IDE-level
        // monitor we can attach because the chat we're pasting into is
        // not a tool window we know about.
        return deliverPrompt(invocation)
    }

    private fun simulatePasteAndSubmit() {
        val robot = Robot()
        robot.autoDelay = 50

        if (SystemInfo.isMac) {
            robot.keyPress(KeyEvent.VK_META)
            robot.keyPress(KeyEvent.VK_V)
            robot.keyRelease(KeyEvent.VK_V)
            robot.keyRelease(KeyEvent.VK_META)
        } else {
            robot.keyPress(KeyEvent.VK_CONTROL)
            robot.keyPress(KeyEvent.VK_V)
            robot.keyRelease(KeyEvent.VK_V)
            robot.keyRelease(KeyEvent.VK_CONTROL)
        }

        Thread.sleep(300)
        robot.keyPress(KeyEvent.VK_ENTER)
        robot.keyRelease(KeyEvent.VK_ENTER)
    }
}
