package com.windsurf.controller.services.strategies

import com.intellij.openapi.diagnostic.Logger
import com.windsurf.controller.services.AgentOutputMonitor
import com.windsurf.controller.services.DetectedAgent
import com.windsurf.controller.services.IdeIntegrationService

/**
 * Last-resort strategy. Claims any agent that wasn't picked up by a
 * specialised one (Tabnine, Cody, Cursor, Junie, Amazon Q, ad-hoc
 * keyword-detected tool windows). Behaviour matches the legacy
 * `AgentOutputMonitor` Swing+JCEF capture exactly — we don't enable
 * the embedded-editor capture path here because the assumption is
 * that the unknown panel uses one of the toolkit-standard renderers.
 *
 * The registry MUST keep this strategy at the end of the list so it
 * never shadows a more specific match.
 */
class GenericFallbackStrategy : AgentStrategy {
    override val name: String = "Generic Swing/JCEF"
    private val logger = Logger.getInstance(GenericFallbackStrategy::class.java)

    override fun canHandle(agent: DetectedAgent?): Boolean = true

    override fun execute(invocation: AgentInvocation): Boolean {
        val ide = IdeIntegrationService.getInstance()
        val sent = ide.sendPromptToAgent(invocation.prompt, invocation.agent?.id)
        if (!sent) return false
        val twId = invocation.agent?.toolWindowId ?: return true
        if (twId.startsWith("__terminal__:")) {
            // Should never get here — terminal-based agents are claimed
            // by ClaudeCodeTerminalStrategy. Be defensive though.
            logger.warn("GenericFallbackStrategy got terminal toolWindow=$twId — skipping monitor")
            return true
        }
        AgentOutputMonitor.getInstance()
            .startMonitoring(invocation.sessionId, twId, invocation.prompt)
        logger.info("Started generic monitor on toolWindow=$twId")
        return true
    }

    override fun stop() {
        AgentOutputMonitor.getInstance().stopMonitoring()
    }
}
