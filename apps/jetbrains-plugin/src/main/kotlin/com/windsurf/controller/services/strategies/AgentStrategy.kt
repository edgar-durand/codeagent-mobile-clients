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
     * Rich-result version of [execute]. New strategies should override
     * this so the relay payload can carry per-strategy metadata
     * (Copilot's `{ sent: true }`, model-switch acks, …). The default
     * wraps the legacy Boolean return so existing strategies stay
     * source-compatible.
     */
    fun executeWithResult(invocation: AgentInvocation): StrategyResult {
        val ok = execute(invocation)
        return StrategyResult(
            delivered = ok,
            message = if (ok) "Prompt sent to ${name}" else "Failed to deliver prompt via ${name}",
        )
    }

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
 * `start_task` invocation. Mirrors the TS-side `AgentInvocation`
 * (apps/vsc-plugin/src/services/strategies/AgentStrategy.ts) — both
 * shapes carry the same logical fields so a mobile-side change that
 * adds e.g. a routing hint lands in one place per plugin without
 * splaying the interface.
 *
 * `project` is JB-specific (no equivalent in VS Code's extension
 * host) so it stays here. `agentId` / `commandId` / `model` are
 * nullable for backward compatibility with the legacy in-process
 * callers (`sendPromptToIde` etc.) that don't have them.
 */
data class AgentInvocation(
    val project: Project,
    val agent: DetectedAgent?,
    val prompt: String,
    val sessionId: String,
    /** Raw agent id from the remote command payload. */
    val agentId: String? = null,
    /** Command id — used by strategies that push a result back to the relay. */
    val commandId: String? = null,
    /** Optional model override from the mobile picker. */
    val model: String? = null,
)

/**
 * Strategy execution outcome. Mirrors the TS-side `StrategyResult`
 * so the relay payload is byte-compatible regardless of which IDE is
 * paired. New strategies should override `executeWithResult` and
 * return a populated StrategyResult; legacy strategies that still
 * return a bare Boolean get wrapped by the default-impl.
 */
data class StrategyResult(
    /** True if the prompt was delivered (or accepted and now streaming). */
    val delivered: Boolean,
    /** Human-facing message for the relay result. */
    val message: String,
    /** Extra fields merged into the relay result payload — e.g. Copilot adds `{ sent: Boolean }`. */
    val extra: Map<String, Any?> = emptyMap(),
)
