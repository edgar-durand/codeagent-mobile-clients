package com.windsurf.controller.services.strategies

import com.intellij.openapi.diagnostic.Logger
import com.windsurf.controller.services.AgentOutputMonitor
import com.windsurf.controller.services.DetectedAgent
import com.windsurf.controller.services.IdeIntegrationService

/**
 * Codeium / Windsurf / Cascade chat. The original `AgentOutputMonitor`
 * was written and tuned against this UI — Swing tree with a JCEF
 * browser inside, captured via `console.log` injection. This strategy
 * preserves that exact behaviour, so the production-tested capture
 * for Windsurf is never accidentally regressed by changes made for
 * other agents.
 */
class WindsurfStrategy : AgentStrategy {
    override val name: String = "Windsurf / Codeium"
    private val logger = Logger.getInstance(WindsurfStrategy::class.java)

    override fun canHandle(agent: DetectedAgent?): Boolean {
        if (agent == null) return false
        if (agent.pluginId.contains("codeium", ignoreCase = true)) return true
        val tw = agent.toolWindowId.lowercase()
        return tw == "cascade" || tw == "windsurf" ||
            tw == "codeium" || tw == "codeium chat"
    }

    override fun execute(invocation: AgentInvocation): Boolean {
        val ide = IdeIntegrationService.getInstance()
        val sent = ide.sendPromptToAgent(invocation.prompt, invocation.agent?.id)
        if (!sent) return false
        val twId = invocation.agent?.toolWindowId ?: return true
        AgentOutputMonitor.getInstance()
            .startMonitoring(invocation.sessionId, twId, invocation.prompt)
        logger.info("Started Windsurf monitor on toolWindow=$twId")
        return true
    }

    override fun stop() {
        AgentOutputMonitor.getInstance().stopMonitoring()
    }
}
