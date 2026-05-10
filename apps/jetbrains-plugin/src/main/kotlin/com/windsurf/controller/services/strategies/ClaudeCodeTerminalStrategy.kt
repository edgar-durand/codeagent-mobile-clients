package com.windsurf.controller.services.strategies

import com.intellij.openapi.diagnostic.Logger
import com.windsurf.controller.services.DetectedAgent
import com.windsurf.controller.services.TerminalAgentService

/**
 * Claude Code, driven through a terminal tab running the `claude` CLI.
 * Reuses the existing {@link TerminalAgentService} which already has
 * the well-tuned PTY parser (chunk protocol, selectors, thinking
 * panels, model switch, pricing).
 *
 *   1. Find or open the "Claude Code" terminal tab.
 *   2. Send the prompt via the terminal widget API (executeCommand).
 *   3. Start the terminal output monitor that reads the JediTerm
 *      buffer and forwards parsed chunks to the backend.
 *
 * No CLI bridge / auto-pair side effects: an earlier iteration spawned
 * a `codeam plugin-bridge` subprocess to take the chat over through
 * the CLI's richer chunk pipeline, but it was creating phantom tabs
 * on every prompt and overwriting good responses with stale TUI
 * chrome. Bringing the CLI back in as a one-session bridge needs more
 * careful design — see the followup issue. The Codespace deploy flow
 * (which uses `codeam pair-auto` INSIDE a remote codespace) is
 * untouched because it goes through `claim-auto-token` from the
 * install script, not from this strategy.
 */
class ClaudeCodeTerminalStrategy : AgentStrategy {
    override val name: String = "Claude Code (terminal)"
    private val logger = Logger.getInstance(ClaudeCodeTerminalStrategy::class.java)

    override fun canHandle(agent: DetectedAgent?): Boolean {
        if (agent == null) return false
        if (agent.toolWindowId.startsWith("__terminal__:claude_code")) return true
        if (agent.pluginId.contains("anthropic", ignoreCase = true)) return true
        if (agent.pluginId.contains("claude", ignoreCase = true)) return true
        return agent.name.contains("Claude Code", ignoreCase = true)
    }

    override fun deliverPrompt(invocation: AgentInvocation): Boolean {
        val configId = invocation.agent?.toolWindowId?.removePrefix("__terminal__:")
            ?: "claude_code"
        val config = TerminalAgentService.TERMINAL_AGENTS.find { it.id == configId }
            ?: TerminalAgentService.TERMINAL_AGENTS.first()
        val terminal = TerminalAgentService.getInstance()
        terminal.setProject(invocation.project)
        val sent = terminal.sendPromptToTerminalAgent(invocation.prompt, config)
        logger.info("ClaudeCodeTerminalStrategy.deliverPrompt returned=$sent")
        return sent
    }

    override fun execute(invocation: AgentInvocation): Boolean {
        if (!deliverPrompt(invocation)) return false
        TerminalAgentService.getInstance().startMonitoring(invocation.sessionId, invocation.prompt)
        return true
    }

    override fun stop() {
        TerminalAgentService.getInstance().stopMonitoring()
    }
}
