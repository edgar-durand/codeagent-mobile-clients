package com.windsurf.controller.services.strategies

import com.intellij.openapi.diagnostic.Logger
import com.windsurf.controller.services.AgentOutputMonitor
import com.windsurf.controller.services.DetectedAgent
import com.windsurf.controller.services.IdeIntegrationService

/**
 * JetBrains AI Assistant — the bundled AI Chat ("AIAssistant" tool
 * window, plugin id `com.intellij.ml.llm`). Recent versions of this
 * panel render the conversation inside a Jetpack Compose Desktop scene
 * (`JewelComposePanelWrapper` → `ComposePanel` → Skia surface). That
 * means there are NO Swing components for the message bubbles, so the
 * earlier `captureEmbeddedEditor` path (which walked live IntelliJ
 * Editors) only ever found the input field — never the response.
 *
 * `aiAssistantMode = true` switches `AgentOutputMonitor` to a
 * Compose-aware capture path: it locates the Compose panel and walks
 * its `AccessibleContext` tree (the only surface that exposes the
 * Compose semantics text), strips the user's own prompt, and emits
 * incremental `text` chunks. Done is inferred via the stability
 * heuristic (no change for `STABLE_THRESHOLD` polls).
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

    override fun execute(invocation: AgentInvocation): Boolean {
        val ide = IdeIntegrationService.getInstance()
        val sent = ide.sendPromptToAgent(invocation.prompt, invocation.agent?.id)
        if (!sent) return false
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
}
