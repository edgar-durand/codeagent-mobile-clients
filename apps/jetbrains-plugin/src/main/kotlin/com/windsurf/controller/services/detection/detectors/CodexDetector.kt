package com.windsurf.controller.services.detection.detectors

import com.windsurf.controller.services.detection.AgentDetector
import com.windsurf.controller.services.detection.DetectionContext
import com.windsurf.controller.services.detection.DetectionResult
import com.windsurf.controller.services.detection.checks.PluginRef
import com.windsurf.controller.services.detection.checks.dirExists
import com.windsurf.controller.services.detection.checks.expandHome
import com.windsurf.controller.services.detection.checks.findInstalledPlugin
import com.windsurf.controller.services.detection.checks.whichBinary

class CodexDetector : AgentDetector {
    override val id = "codex"
    override val name = "Codex"
    override val icon = "codex"

    // OpenAI Codex was integrated natively into the JetBrains AI Assistant
    // plugin from v2025.3 onward. The id `com.intellij.ml.llm` is the AI
    // Assistant plugin id. Third-party Codex plugins (marketplace IDs
    // 28264 / 31307 / 29342) have unconfirmed string ids and are
    // intentionally omitted — the official AI Assistant path covers most
    // installs and the binary + config-dir fallbacks cover the rest.
    private val candidatePlugins = listOf(
        PluginRef(id = "com.intellij.ml.llm", minVersion = "2025.3"),
    )
    private val binaryName = "codex"
    private val configDir = "~/.codex"

    override suspend fun detect(ctx: DetectionContext): DetectionResult? {
        val plugin = findInstalledPlugin(candidatePlugins)
        if (plugin != null) {
            return DetectionResult(extensionId = plugin.id, via = DetectionResult.Via.EXTENSION)
        }
        val binPath = whichBinary(binaryName)
        if (binPath != null) {
            ctx.logger.info("[CodexDetector] binary at $binPath")
            return DetectionResult(extensionId = "__binary__:$binaryName", via = DetectionResult.Via.BINARY)
        }
        if (dirExists(expandHome(configDir))) {
            ctx.logger.info("[CodexDetector] config dir $configDir present")
            return DetectionResult(extensionId = "__config__:$binaryName", via = DetectionResult.Via.CONFIG_DIR)
        }
        return null
    }
}
