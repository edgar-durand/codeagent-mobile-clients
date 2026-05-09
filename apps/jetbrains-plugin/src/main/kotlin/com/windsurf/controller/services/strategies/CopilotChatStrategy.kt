package com.windsurf.controller.services.strategies

import com.intellij.openapi.diagnostic.Logger
import com.windsurf.controller.services.AgentOutputMonitor
import com.windsurf.controller.services.DetectedAgent
import com.windsurf.controller.services.IdeIntegrationService

/**
 * GitHub Copilot Chat. Renders inside JCEF (Chromium-embedded), so the
 * shared `AgentOutputMonitor` JCEF console-capture path applies the
 * same way it does for Windsurf. Kept as its own strategy so we have a
 * dedicated seam for Copilot-specific quirks if the chat UI evolves.
 *
 * Note: the `github.copilotToolWindow` and `GitHub Copilot MCP Log`
 * windows are completion/log surfaces, not chat — they are excluded
 * upstream by `IdeIntegrationService.completionToolWindowIds`, so this
 * strategy only ever sees the actual `GitHub Copilot Chat` window.
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

    override fun execute(invocation: AgentInvocation): Boolean {
        val ide = IdeIntegrationService.getInstance()
        val sent = ide.sendPromptToAgent(invocation.prompt, invocation.agent?.id)
        if (!sent) return false
        val twId = invocation.agent?.toolWindowId ?: return true
        AgentOutputMonitor.getInstance()
            .startMonitoring(invocation.sessionId, twId, invocation.prompt)
        logger.info("Started Copilot monitor on toolWindow=$twId")
        return true
    }

    override fun stop() {
        AgentOutputMonitor.getInstance().stopMonitoring()
    }
}
