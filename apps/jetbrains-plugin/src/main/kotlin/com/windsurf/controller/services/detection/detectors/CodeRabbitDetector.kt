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
 * CodeRabbit — terminal agent owned by codeam-cli's BatchAgentStrategy.
 * Probes the marketplace plugin (id best-effort), the `coderabbit`
 * binary, and the `~/.coderabbit/` config directory.
 */
class CodeRabbitDetector : AgentDetector {
    override val id = "coderabbit"
    override val name = "CodeRabbit"
    override val icon = "coderabbit"

    private val candidatePlugins = listOf(
        PluginRef(id = "com.coderabbit.coderabbit-jetbrains"),
    )
    private val binaryName = "coderabbit"
    private val configDir = "~/.coderabbit"

    override suspend fun detect(ctx: DetectionContext): List<DetectionResult> {
        val plugin = findInstalledPlugin(candidatePlugins)
        val installed = plugin != null ||
            whichBinary(binaryName) != null ||
            dirExists(expandHome(configDir))
        if (!installed) return emptyList()
        ctx.logger.info("[CodeRabbitDetector] detected (plugin=${plugin?.id ?: "none"})")
        return listOf(
            DetectionResult(
                id = id,
                name = name,
                icon = icon,
                pluginId = plugin?.id ?: "coderabbit.coderabbit",
                toolWindowId = "__terminal__:$id",
                isTerminalAgent = true,
            ),
        )
    }
}
