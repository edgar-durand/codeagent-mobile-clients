package com.windsurf.controller.services.detection.detectors

import com.windsurf.controller.services.detection.AgentDetector
import com.windsurf.controller.services.detection.DetectionContext
import com.windsurf.controller.services.detection.DetectionResult
import com.windsurf.controller.services.detection.checks.PluginRef
import com.windsurf.controller.services.detection.checks.dirExists
import com.windsurf.controller.services.detection.checks.expandHome
import com.windsurf.controller.services.detection.checks.findInstalledPlugin
import com.windsurf.controller.services.detection.checks.whichBinary

/**
 * Claude Code — terminal agent owned by codeam-cli. We report
 * presence so the mobile picker can list Claude as an option; runtime
 * (start_task / select_option / …) is dispatched to the CLI's pluginId.
 *
 * Probes plugin, binary, then `~/.claude/`. Any signal flips the wire
 * id to `__terminal__:claude_code` so the backend routes commands at
 * the CLI rather than at this plugin.
 */
class ClaudeCodeDetector : AgentDetector {
    override val id = "claude_code"
    override val name = "Claude Code"
    override val icon = "claude"

    private val candidatePlugins = listOf(
        PluginRef(id = "com.anthropic.claudecode"),
        PluginRef(id = "com.anthropic.claude"),
        PluginRef(id = "anthropic.claude"),
    )
    private val binaryName = "claude"
    private val configDir = "~/.claude"

    override suspend fun detect(ctx: DetectionContext): List<DetectionResult> {
        val plugin = findInstalledPlugin(candidatePlugins)
        val installed = plugin != null ||
            whichBinary(binaryName) != null ||
            dirExists(expandHome(configDir))
        if (!installed) return emptyList()
        ctx.logger.info("[ClaudeCodeDetector] detected (plugin=${plugin?.id ?: "none"})")
        return listOf(
            DetectionResult(
                id = id,
                name = name,
                icon = icon,
                pluginId = plugin?.id ?: "com.anthropic.claudecode",
                toolWindowId = "__terminal__:$id",
                isTerminalAgent = true,
            ),
        )
    }
}
