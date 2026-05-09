package com.windsurf.controller.services.strategies

import com.intellij.openapi.diagnostic.Logger
import com.windsurf.controller.services.AgentOutputMonitor
import com.windsurf.controller.services.DetectedAgent
import com.windsurf.controller.services.IdeIntegrationService

/**
 * JetBrains AI Assistant — the bundled AI Chat ("AIAssistant" tool
 * window, plugin id `com.intellij.ml.llm`). Recent versions of this
 * panel render message bubbles inside `EditorComponentImpl`, IntelliJ's
 * full code-editor widget. That component is NOT a `JTextComponent`,
 * so the generic Swing scrape never sees the response text and the
 * polling loop times out with "No content captured after 15 polls".
 *
 * This strategy adds the embedded-Editor capture path on top of the
 * normal Swing scrape — `AgentOutputMonitor.startMonitoring` accepts a
 * `captureEmbeddedEditor` flag that pulls `editor.document.text` for
 * every editor hosted under the tool window. Other strategies do NOT
 * pass the flag, so their behaviour is unchanged.
 *
 * Diagnosed against WebStorm 2026.1 + JetBrains AI Assistant + Codex
 * (May 2026): `AccessibleJPanel` tree dominated by `AIAssistant*`
 * classes and at least one `EditorComponentImpl` per response bubble.
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
            invocation.sessionId,
            twId,
            invocation.prompt,
            captureEmbeddedEditor = true,
        )
        logger.info("Started AI Assistant monitor (embedded editor capture) on toolWindow=$twId")
        return true
    }

    override fun stop() {
        AgentOutputMonitor.getInstance().stopMonitoring()
    }
}
