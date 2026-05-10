package com.windsurf.controller.services.strategies

import com.intellij.openapi.diagnostic.Logger
import com.windsurf.controller.services.AgentOutputMonitor
import com.windsurf.controller.services.DetectedAgent

/**
 * Last-resort strategy. Claims any agent that wasn't picked up by a
 * specialised one (Tabnine, Cody, Cursor, Junie, Amazon Q, ad-hoc
 * keyword-detected tool windows). Self-contained: uses the shared
 * generic JCEF helper for sending and the legacy `AgentOutputMonitor`
 * Swing+JCEF capture for receiving — both contain no agent-specific
 * code, so reusing them across unknown vendors does not couple this
 * strategy to any other.
 *
 * The registry MUST keep this strategy at the end of the list so it
 * never shadows a more specific match.
 */
class GenericFallbackStrategy : AgentStrategy {
    override val name: String = "Generic Swing/JCEF"
    private val logger = Logger.getInstance(GenericFallbackStrategy::class.java)

    override fun canHandle(agent: DetectedAgent?): Boolean = true

    override fun deliverPrompt(invocation: AgentInvocation): Boolean {
        // Should never get here for terminal-routed agents — those are
        // claimed by ClaudeCodeTerminalStrategy. Be defensive.
        val twId = invocation.agent?.toolWindowId ?: ""
        if (twId.startsWith("__terminal__:")) {
            logger.warn("GenericFallbackStrategy got terminal toolWindow=$twId — refusing to dispatch")
            return false
        }
        return deliverPromptViaJcef(
            invocation = invocation,
            notificationTitle = "Prompt sent to AI",
            notFoundMessage = "Prompt copied to clipboard (no AI agent found)",
            logger = logger,
        )
    }

    override fun execute(invocation: AgentInvocation): Boolean {
        if (!deliverPrompt(invocation)) return false
        val twId = invocation.agent?.toolWindowId ?: return true
        if (twId.startsWith("__terminal__:")) return true
        AgentOutputMonitor.getInstance()
            .startMonitoring(invocation.sessionId, twId, invocation.prompt)
        logger.info("Started generic monitor on toolWindow=$twId")
        return true
    }

    override fun stop() {
        AgentOutputMonitor.getInstance().stopMonitoring()
    }
}
