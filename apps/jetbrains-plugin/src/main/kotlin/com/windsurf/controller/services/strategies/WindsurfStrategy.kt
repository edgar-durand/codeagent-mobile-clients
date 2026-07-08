package com.windsurf.controller.services.strategies

import com.intellij.openapi.diagnostic.Logger
import com.windsurf.controller.services.AgentOutputMonitor
import com.windsurf.controller.services.DetectedAgent
import com.windsurf.controller.services.IdeIntegrationService
import com.windsurf.controller.ui.BrandMessages

/**
 * Codeium / Windsurf / Cascade chat. Renders inside a JCEF browser, so
 * the JCEF JS injection path delivers the prompt and the production-
 * tested Swing+JCEF capture handles the output. Self-contained: no
 * shared dispatcher, no other-agent code reaches this file.
 *
 * The shared `deliverPromptViaJcef` helper is a generic JCEF building
 * block — it has no Codeium-specific selectors or behaviours. Anything
 * Windsurf-specific (capture, idle/done heuristics) lives here or in
 * the `AgentOutputMonitor` Windsurf-default extractor.
 */
class WindsurfStrategy : AgentStrategy {
    override val name: String = "Windsurf / Codeium"
    private val logger = Logger.getInstance(WindsurfStrategy::class.java)

    /** Last handled invocation — lets `stop()` re-resolve the surface to interrupt. */
    @Volatile private var lastInvocation: AgentInvocation? = null

    override fun canHandle(agent: DetectedAgent?): Boolean {
        if (agent == null) return false
        if (agent.pluginId.contains("codeium", ignoreCase = true)) return true
        val tw = agent.toolWindowId.lowercase()
        return tw == "cascade" || tw == "windsurf" ||
            tw == "codeium" || tw == "codeium chat"
    }

    override fun deliverPrompt(invocation: AgentInvocation): Boolean {
        lastInvocation = invocation
        return deliverPromptViaJcef(
            invocation = invocation,
            notificationTitle = "Prompt sent to Windsurf",
            notFoundMessage = BrandMessages.promptCopiedToClipboard("Windsurf chat not detected"),
            logger = logger,
        )
    }

    override fun execute(invocation: AgentInvocation): Boolean {
        if (!deliverPrompt(invocation)) return false
        val twId = invocation.agent?.toolWindowId ?: return true
        AgentOutputMonitor.getInstance()
            .startMonitoring(invocation.sessionId, twId, invocation.prompt)
        logger.info("Started Windsurf monitor on toolWindow=$twId")
        return true
    }

    override fun stop() {
        lastInvocation?.let {
            try {
                val ide = IdeIntegrationService.getInstance()
                SurfaceInterrupt.interrupt(ide, it.project, it.agent, ide.detectInstalledAgents())
            } catch (e: Exception) {
                logger.trace(e)
            }
        }
        AgentOutputMonitor.getInstance().stopMonitoring()
    }
}
