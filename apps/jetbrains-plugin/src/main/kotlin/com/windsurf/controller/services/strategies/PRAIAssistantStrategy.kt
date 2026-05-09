package com.windsurf.controller.services.strategies

import com.intellij.openapi.diagnostic.Logger
import com.windsurf.controller.services.AgentOutputMonitor
import com.windsurf.controller.services.DetectedAgent
import com.windsurf.controller.services.IdeIntegrationService

/**
 * "PR AI Assistant" tool window — JetBrains' code-review companion to
 * the main AI Assistant. Same `com.intellij.ml.llm.*` provenance, so
 * we apply the same embedded-editor capture path.
 *
 * Kept as its own strategy (vs. folding it into
 * {@link JetBrainsAIAssistantStrategy}) so a future renderer change
 * specific to PR-review chats can be addressed without touching the
 * main AI Chat path.
 */
class PRAIAssistantStrategy : AgentStrategy {
    override val name: String = "PR AI Assistant"
    private val logger = Logger.getInstance(PRAIAssistantStrategy::class.java)

    override fun canHandle(agent: DetectedAgent?): Boolean {
        if (agent == null) return false
        return agent.toolWindowId.equals("PR AI Assistant", ignoreCase = true)
    }

    override fun execute(invocation: AgentInvocation): Boolean {
        val ide = IdeIntegrationService.getInstance()
        val sent = ide.sendPromptToAgent(invocation.prompt, invocation.agent?.id)
        if (!sent) return false
        val twId = invocation.agent?.toolWindowId ?: return true
        AgentOutputMonitor.getInstance().startMonitoring(
            invocation.sessionId,
            twId,
            invocation.prompt,
            captureEmbeddedEditor = true,
        )
        logger.info("Started PR AI Assistant monitor on toolWindow=$twId")
        return true
    }

    override fun stop() {
        AgentOutputMonitor.getInstance().stopMonitoring()
    }
}
