package com.windsurf.controller.services.strategies

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.windsurf.controller.services.AgentOutputMonitor
import com.windsurf.controller.services.TerminalAgentService

/**
 * Routes an `AgentInvocation` to the first {@link AgentStrategy} whose
 * `canHandle` returns true. Order matters — agent-specific strategies
 * come first so the {@link GenericFallbackStrategy} only catches the
 * tail.
 *
 * The registry also remembers the strategy that ran the most recent
 * invocation so a `stop_task` command can call its `stop()` without
 * the caller having to track which one. As a belt-and-suspenders, we
 * also stop the legacy singletons (AgentOutputMonitor, TerminalAgent-
 * Service) directly — if a refactor regression ever leaks a poll
 * loop, the user's "stop" button still kills it.
 */
@Service(Service.Level.APP)
class AgentStrategyRegistry {

    private val logger = Logger.getInstance(AgentStrategyRegistry::class.java)

    private val strategies: List<AgentStrategy> = listOf(
        ClaudeCodeTerminalStrategy(),
        WindsurfStrategy(),
        CopilotChatStrategy(),
        JetBrainsAIAssistantStrategy(),
        PRAIAssistantStrategy(),
        GenericFallbackStrategy(),
    )

    @Volatile
    private var lastActive: AgentStrategy? = null

    /**
     * Resolve a strategy for this invocation and run it. Returns the
     * underlying `execute` boolean (true on success). Never throws —
     * a strategy that crashes is logged and treated as a delivery
     * failure; the caller falls back to its own clipboard handling.
     */
    fun execute(invocation: AgentInvocation): Boolean {
        val strategy = strategies.firstOrNull { it.canHandle(invocation.agent) }
        if (strategy == null) {
            logger.warn("No strategy claimed agent=${invocation.agent?.id ?: "<null>"}")
            return false
        }
        logger.info(
            "Strategy=${strategy.name} agent=${invocation.agent?.id ?: "<null>"} " +
                "toolWindow=${invocation.agent?.toolWindowId ?: "<null>"}"
        )
        // Stop any previous monitor before kicking off a new one — keeps
        // the user's chat consistent if they switch agents mid-session.
        if (lastActive != null && lastActive !== strategy) {
            try { lastActive?.stop() } catch (e: Exception) { logger.debug("prev stop: ${e.message}") }
        }
        lastActive = strategy
        return try {
            strategy.execute(invocation)
        } catch (e: Exception) {
            logger.warn("Strategy ${strategy.name} threw: ${e.message}", e)
            false
        }
    }

    /** Stop whatever the last invocation started. */
    fun stop() {
        try { lastActive?.stop() } catch (e: Exception) { logger.debug("stop: ${e.message}") }
        lastActive = null
        // Belt-and-suspenders: nuke the singleton monitors directly so a
        // mid-refactor regression can never leave a poll loop running.
        try { AgentOutputMonitor.getInstance().stopMonitoring() } catch (_: Exception) {}
        try { TerminalAgentService.getInstance().stopMonitoring() } catch (_: Exception) {}
    }

    companion object {
        fun getInstance(): AgentStrategyRegistry =
            ApplicationManager.getApplication().getService(AgentStrategyRegistry::class.java)
    }
}
