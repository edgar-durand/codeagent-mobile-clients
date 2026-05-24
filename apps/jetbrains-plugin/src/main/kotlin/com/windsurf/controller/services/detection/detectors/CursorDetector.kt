package com.windsurf.controller.services.detection.detectors

import com.windsurf.controller.services.detection.AgentDetector
import com.windsurf.controller.services.detection.DetectionContext
import com.windsurf.controller.services.detection.DetectionResult
import com.windsurf.controller.services.detection.checks.dirExists
import com.windsurf.controller.services.detection.checks.expandHome
import com.windsurf.controller.services.detection.checks.whichBinary

/**
 * Cursor's headless CLI agent — terminal agent owned by codeam-cli.
 * Cursor is a VS Code fork that doesn't ship a JetBrains plugin, so
 * detection is limited to the `cursor-agent` binary on PATH and the
 * `~/.cursor` config directory (created on first IDE launch / agent
 * login).
 */
class CursorDetector : AgentDetector {
    override val id = "cursor"
    override val name = "Cursor Agent"
    override val icon = "cursor"

    private val binaryName = "cursor-agent"
    private val configDir = "~/.cursor"

    override suspend fun detect(ctx: DetectionContext): List<DetectionResult> {
        val installed = whichBinary(binaryName) != null || dirExists(expandHome(configDir))
        if (!installed) return emptyList()
        ctx.logger.info("[CursorDetector] detected")
        return listOf(
            DetectionResult(
                id = id,
                name = name,
                icon = icon,
                pluginId = "cursor.cursor-agent",
                toolWindowId = "__terminal__:$id",
                isTerminalAgent = true,
            ),
        )
    }
}
