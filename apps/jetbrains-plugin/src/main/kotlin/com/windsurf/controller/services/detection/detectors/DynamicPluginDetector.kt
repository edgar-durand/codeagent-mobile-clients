package com.windsurf.controller.services.detection.detectors

import com.intellij.ide.plugins.PluginManagerCore
import com.windsurf.controller.services.PluginDescriptors
import com.windsurf.controller.services.detection.AgentDetector
import com.windsurf.controller.services.detection.DetectionContext
import com.windsurf.controller.services.detection.DetectionResult

/**
 * Catch-all for AI plugins not covered by a specific [InIdeChatDetector].
 * Scans every installed (and enabled) IntelliJ plugin and keeps the
 * ones whose name or description matches one of [keywords], minus the
 * self plugin and any id already claimed earlier in the run.
 *
 * Returns 0..N results — emits one [DetectionResult] per matched
 * plugin so the mobile picker surfaces every AI tool the user has,
 * even ones we don't recognise by id.
 */
class DynamicPluginDetector(
    private val keywords: List<String> = DEFAULT_KEYWORDS,
    private val excludedPluginIds: Set<String> = setOf("com.codeagent.mobile"),
) : AgentDetector {
    override val id = "__dynamic-plugin__"
    override val name = "Dynamic AI Plugin"
    override val icon = "generic-ai"

    override suspend fun detect(ctx: DetectionContext): List<DetectionResult> {
        val results = mutableListOf<DetectionResult>()
        for (descriptor in PluginDescriptors.all()) {
            val pluginId = descriptor.pluginId
            val pid = pluginId.idString
            if (pid in excludedPluginIds) continue
            if (pid in ctx.alreadyDetectedIds) continue
            if (PluginManagerCore.isDisabled(pluginId)) continue

            val nameLower = descriptor.name.lowercase()
            val descLower = (descriptor.description ?: "").lowercase()
            val matchedName = keywords.any { nameLower.contains(it) }
            val matchedDesc = keywords.any { descLower.contains(it) }
            if (!matchedName && !matchedDesc) continue

            val icon = resolveIcon(nameLower)
            results += DetectionResult(
                id = pid,
                name = descriptor.name,
                icon = icon,
                pluginId = pid,
                toolWindowId = descriptor.name,
                isTerminalAgent = false,
            )
            ctx.logger.info("[DynamicPluginDetector] matched plugin: ${descriptor.name} ($pid)")
        }
        return results
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
            "ai assistant", "copilot", "claude", "cody", "cascade", "windsurf",
            "codeium", "tabnine", "gemini", "supermaven", "continue", "aider",
            "code companion", "chatgpt", "anthropic", "openai", "amazon q",
        )
    }
}
