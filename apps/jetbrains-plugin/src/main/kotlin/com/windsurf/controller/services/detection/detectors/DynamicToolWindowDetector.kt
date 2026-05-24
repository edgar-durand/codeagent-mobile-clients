package com.windsurf.controller.services.detection.detectors

import com.windsurf.controller.services.detection.AgentDetector
import com.windsurf.controller.services.detection.DetectionContext
import com.windsurf.controller.services.detection.DetectionResult
import com.windsurf.controller.services.detection.checks.listToolWindowIds

/**
 * Catch-all for AI agents that expose a tool window but don't have a
 * known plugin id this codebase enumerates. Scans the project's
 * tool-window list and emits one [DetectionResult] per tool window
 * whose id contains an AI keyword AND isn't a completion / log panel
 * (Copilot exposes both, only the Chat one is a valid prompt target).
 *
 * Skipped when [DetectionContext.project] is null — there's no
 * tool-window manager outside of an open project window.
 */
class DynamicToolWindowDetector(
    private val keywords: List<String> = DEFAULT_KEYWORDS,
) : AgentDetector {
    override val id = "__dynamic-tool-window__"
    override val name = "Dynamic Tool-Window Agent"
    override val icon = "generic-ai"

    override suspend fun detect(ctx: DetectionContext): List<DetectionResult> {
        val project = ctx.project ?: return emptyList()
        val ids = listToolWindowIds(project)
        if (ids.isEmpty()) return emptyList()

        val results = mutableListOf<DetectionResult>()
        for (twId in ids) {
            val lower = twId.lowercase()
            if (lower in SELF_TOOL_WINDOWS) continue
            if (isNonChatPromptTarget(lower)) continue
            if (twId in ctx.alreadyDetectedIds) continue
            if (keywords.none { lower.contains(it) }) continue

            val icon = resolveIcon(lower)
            results += DetectionResult(
                id = twId,
                name = twId,
                icon = icon,
                pluginId = twId,
                toolWindowId = twId,
                isTerminalAgent = false,
            )
            ctx.logger.info("[DynamicToolWindowDetector] matched toolWindow: $twId")
        }
        return results
    }

    private fun isNonChatPromptTarget(lower: String): Boolean {
        if (lower in COMPLETION_TOOL_WINDOWS) return true
        // Any Copilot panel that isn't the Chat panel — code suggestions,
        // MCP Log, generic completion windows — must never be a prompt
        // target.
        if (lower.contains("copilot") && !lower.contains("chat")) return true
        return false
    }

    private fun resolveIcon(nameLower: String): String = when {
        nameLower.contains("claude") || nameLower.contains("anthropic") -> "claude"
        nameLower.contains("copilot") -> "copilot"
        nameLower.contains("codeium") || nameLower.contains("windsurf") || nameLower.contains("cascade") -> "codeium"
        nameLower.contains("tabnine") -> "tabnine"
        nameLower.contains("cody") -> "cody"
        nameLower.contains("amazon") -> "amazon-q"
        nameLower.contains("junie") -> "junie"
        nameLower.contains("gemini") -> "jetbrains-ai"
        nameLower.contains("cursor") -> "cursor"
        else -> "generic-ai"
    }

    companion object {
        private val DEFAULT_KEYWORDS = listOf(
            "ai", "copilot", "assistant", "claude", "cody", "cursor",
            "cascade", "windsurf", "codeium", "tabnine", "gemini", "codey",
            "supermaven", "continue", "aider", "llm", "gpt", "anthropic",
        )
        private val COMPLETION_TOOL_WINDOWS = setOf("github copilot", "copilot")
        private val SELF_TOOL_WINDOWS = setOf("codeagent-mobile", "codeagent mobile")
    }
}
