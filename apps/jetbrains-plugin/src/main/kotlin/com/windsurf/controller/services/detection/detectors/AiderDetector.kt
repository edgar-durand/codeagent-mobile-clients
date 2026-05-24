package com.windsurf.controller.services.detection.detectors

import com.windsurf.controller.services.detection.AgentDetector
import com.windsurf.controller.services.detection.DetectionContext
import com.windsurf.controller.services.detection.DetectionResult
import com.windsurf.controller.services.detection.checks.expandHome
import com.windsurf.controller.services.detection.checks.fileExists
import com.windsurf.controller.services.detection.checks.whichBinary

/**
 * Aider — terminal agent owned by codeam-cli. No JetBrains plugin
 * exists; detection is the `aider` binary on PATH or the single-file
 * config `~/.aider.conf.yml`.
 */
class AiderDetector : AgentDetector {
    override val id = "aider"
    override val name = "Aider"
    override val icon = "aider"

    private val binaryName = "aider"
    // Aider config-file locations, in priority order. All three are
    // documented in Aider's README and work cross-platform — the
    // `~/.config/aider/` variant is the XDG-spec path Linux users
    // tend to prefer, the `~/.aider.conf.yml` form is the historical
    // default that also resolves correctly on Windows
    // (`C:\Users\<user>\.aider.conf.yml`).
    private val configFiles = listOf(
        "~/.aider.conf.yml",
        "~/.config/aider/aider.conf.yml",
    )

    override suspend fun detect(ctx: DetectionContext): List<DetectionResult> {
        val configPresent = configFiles.any { fileExists(expandHome(it)) }
        val installed = whichBinary(binaryName) != null || configPresent
        if (!installed) return emptyList()
        ctx.logger.info("[AiderDetector] detected")
        return listOf(
            DetectionResult(
                id = id,
                name = name,
                icon = icon,
                pluginId = "aider.aider",
                toolWindowId = "__terminal__:$id",
                isTerminalAgent = true,
            ),
        )
    }
}
