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
     * Wall-clock millis of the most recent `execute()` / `deliverPrompt()`.
     * Read by FileWatcherService (Path B) to decide whether a VFS event
     * happened inside the "an agent is doing work" window — without that
     * gate every human save during idle time floods the Pending Review
     * Queue. Updated on `stop()` too so the window naturally extends a
     * little past the explicit stop, covering the writeback of any
     * file mutations the agent already kicked off.
     */
    @Volatile
    private var lastActiveAt: Long = 0L

    /**
     * Return true when an agent has been active in the last
     * `AGENT_ACTIVE_WINDOW_MS` window. The FileWatcherService gates
     * emissions on this so it only emits during active-agent runs.
     */
    fun recentlyActive(): Boolean {
        val ts = lastActiveAt
        if (ts == 0L) return false
        return System.currentTimeMillis() - ts <= AGENT_ACTIVE_WINDOW_MS
    }

    /**
     * Returns the timestamp of the most recent activity (or 0 when no
     * agent has run since plugin start). Exposed mostly for tests +
     * diagnostics — production callers should prefer `recentlyActive()`.
     */
    fun lastActiveAtMs(): Long = lastActiveAt

    /**
     * Force-mark the registry as active right now. Used by integration
     * points outside the normal `execute()` path (e.g. JCEF prompt
     * injection that doesn't go through the registry but still counts
     * as agent work).
     */
    fun markActiveNow() {
        lastActiveAt = System.currentTimeMillis()
    }

    /**
     * Resolve a strategy for this invocation and run it. Returns the
     * underlying `execute` boolean (true on success). Never throws —
     * a strategy that crashes is logged and treated as a delivery
     * failure; the caller falls back to its own clipboard handling.
     */
    fun execute(invocation: AgentInvocation): Boolean = executeWithResult(invocation).delivered

    /**
     * Rich-result execute — returns the [StrategyResult] shape that
     * mirrors the TS-side strategies so the relay payload is wire-
     * compatible across plugins. Callers that need the message + extra
     * fields (model-switch acks, per-strategy metadata) should use this.
     */
    fun executeWithResult(invocation: AgentInvocation): StrategyResult {
        val strategy = strategies.firstOrNull { it.canHandle(invocation.agent) }
        if (strategy == null) {
            logger.warn("No strategy claimed agent=${invocation.agent?.id ?: "<null>"}")
            return StrategyResult(delivered = false, message = "No strategy claimed this agent")
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
        lastActiveAt = System.currentTimeMillis()
        return try {
            strategy.executeWithResult(invocation)
        } catch (e: Exception) {
            logger.warn("Strategy ${strategy.name} threw: ${e.message}", e)
            StrategyResult(delivered = false, message = "Strategy ${strategy.name} crashed: ${e.message ?: "unknown"}")
        }
    }

    /**
     * Deliver a prompt without starting a monitor. Used by ad-hoc
     * "type into the active agent" inputs (the plugin's own side
     * panel), where there is no `start_task` lifecycle. Routes through
     * the same `canHandle` logic so each agent's specific delivery
     * path (Swing, JCEF, terminal) is honoured.
     */
    fun deliverPrompt(invocation: AgentInvocation): Boolean {
        val strategy = strategies.firstOrNull { it.canHandle(invocation.agent) }
        if (strategy == null) {
            logger.warn("No strategy claimed agent=${invocation.agent?.id ?: "<null>"} for deliverPrompt")
            return false
        }
        logger.info("deliverPrompt strategy=${strategy.name} agent=${invocation.agent?.id ?: "<null>"}")
        lastActiveAt = System.currentTimeMillis()
        return try {
            strategy.deliverPrompt(invocation)
        } catch (e: Exception) {
            logger.warn("Strategy ${strategy.name} deliverPrompt threw: ${e.message}", e)
            false
        }
    }

    /** Stop whatever the last invocation started. */
    fun stop() {
        // Bump lastActiveAt one last time so the FileWatcherService
        // emission window stays open long enough for the agent's
        // in-flight file writes to land - otherwise the user clicks
        // "stop" right after the agent edited 3 files and the events
        // get silently dropped.
        lastActiveAt = System.currentTimeMillis()
        try { lastActive?.stop() } catch (e: Exception) { logger.debug("stop: ${e.message}") }
        lastActive = null
        // Belt-and-suspenders: nuke the singleton monitors directly so a
        // mid-refactor regression can never leave a poll loop running.
        try { AgentOutputMonitor.getInstance().stopMonitoring() } catch (_: Exception) {}
        try { TerminalAgentService.getInstance().stopMonitoring() } catch (_: Exception) {}
    }

    companion object {
        /**
         * How long after the last `execute()` / `deliverPrompt()` /
         * `stop()` to keep emitting file-change events. 90 s covers
         * the typical agent-edit burst (Claude commits 5-15 files
         * over 10-60 s) without leaving the queue exposed to drive-by
         * human edits.
         */
        const val AGENT_ACTIVE_WINDOW_MS: Long = 90_000

        fun getInstance(): AgentStrategyRegistry =
            ApplicationManager.getApplication().getService(AgentStrategyRegistry::class.java)
    }
}
