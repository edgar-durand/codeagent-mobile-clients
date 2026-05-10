package com.windsurf.controller.services.strategies

import com.intellij.openapi.project.Project
import com.windsurf.controller.services.DetectedAgent

/**
 * One concrete way of driving an AI coding agent inside the IDE: send
 * the user's prompt into its UI and start capturing its output back to
 * the CodeAgent backend.
 *
 * Why a Strategy pattern?
 *   - Different agents render their chat with very different toolkits
 *     (Swing JEditorPane, JCEF/Chromium, EditorEx, terminal PTY) and a
 *     monolithic if/else in `IdeIntegrationService` was already biting
 *     us — a fix for one renderer (e.g. JetBrains AI Assistant moving
 *     to embedded `EditorComponentImpl`) risked silently breaking the
 *     others (Windsurf, Copilot, Claude Code) which were captured
 *     fine before.
 *   - Each agent's send/capture pair is now an isolated unit. Adding a
 *     new agent or fixing one renderer cannot regress the others.
 *
 * Strategies are pure logic — they hold no per-task state. The Output
 * Monitor and Terminal Service singletons hold the polling state and
 * are reused across invocations. `stop()` is the hook for tearing down
 * a long-running monitor when the user cancels mid-task.
 */
interface AgentStrategy {
    /** Human-readable name used in logs ("Claude Code (terminal)"). */
    val name: String

    /**
     * `true` when this strategy claims responsibility for the given
     * detected agent. Order matters in the registry — the first
     * matching strategy wins, with a fallback at the end so any
     * unrecognised tool window still gets the best-effort generic
     * Swing+JCEF capture.
     */
    fun canHandle(agent: DetectedAgent?): Boolean

    /**
     * Deliver the prompt into the agent's UI ONLY — no monitor, no
     * `start_task` bookkeeping. This is the path used by ad-hoc inputs
     * coming from the plugin's own side panel (`sendPromptToIde`),
     * where the user just wants the prompt to land in the chat.
     *
     * Each strategy is fully self-contained here: it resolves its own
     * tool window, decides whether to inject via Swing / JCEF / Robot
     * / terminal, and never delegates to a shared dispatcher in
     * `IdeIntegrationService`. Returns `false` if delivery failed so
     * the caller can fall back to clipboard + notification.
     */
    fun deliverPrompt(invocation: AgentInvocation): Boolean

    /**
     * `start_task` entry point. Default implementation delivers the
     * prompt then starts the strategy's monitor; override only if a
     * strategy needs to interleave the two (e.g. terminal-based agents
     * that own their own capture loop and bypass `AgentOutputMonitor`).
     */
    fun execute(invocation: AgentInvocation): Boolean

    /**
     * Stop any monitor that this strategy started. Default no-op for
     * fire-and-forget strategies; the chat ones override it to call
     * AgentOutputMonitor / TerminalAgentService stop methods.
     */
    fun stop() {
        // no-op default
    }
}

/**
 * Immutable bundle of everything a strategy needs to run a single
 * `start_task` invocation. Avoids passing 4-5 positional args around
 * and keeps the interface stable as we add fields (e.g. attachments).
 */
data class AgentInvocation(
    val project: Project,
    val agent: DetectedAgent?,
    val prompt: String,
    val sessionId: String,
)
