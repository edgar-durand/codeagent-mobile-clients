package com.windsurf.controller.services.strategies

import com.intellij.openapi.diagnostic.Logger
import com.windsurf.controller.services.AgentOutputMonitor
import com.windsurf.controller.services.DetectedAgent

/**
 * "PR AI Assistant" tool window — JetBrains' code-review companion to
 * the main AI Assistant. Same `com.intellij.ml.llm.*` provenance, but
 * historically it has used a different renderer than the main chat
 * (Swing-only, no Compose surface), so the embedded-editor capture
 * path applies here even though it does not on the main AI Assistant.
 *
 * Sending side: PR AI Assistant has historically rendered inside a
 * JCEF panel for the agentic UI, so the shared JCEF helper covers it.
 * If a future renderer change moves the input out of JCEF this is
 * where we'd add a Swing-direct path mirroring CopilotChatStrategy.
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

    override fun deliverPrompt(invocation: AgentInvocation): Boolean = deliverPromptViaJcef(
        invocation = invocation,
        notificationTitle = "Prompt sent to PR AI Assistant",
        notFoundMessage = "Prompt copied to clipboard (PR AI Assistant not found)",
        logger = logger,
    )

    override fun execute(invocation: AgentInvocation): Boolean {
        if (!deliverPrompt(invocation)) return false
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
