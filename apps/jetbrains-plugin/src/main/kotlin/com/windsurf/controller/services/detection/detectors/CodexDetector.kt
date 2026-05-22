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

    // Plugin candidates, checked in priority order. First match wins.
    //
    // 1. Official: OpenAI Codex was integrated natively into the JetBrains
    //    AI Assistant plugin from v2025.3 onward — `com.intellij.ml.llm`
    //    is the AI Assistant plugin id. Most installs are here.
    //
    // 2-4. Third-party Codex plugins (string ids confirmed against the
    //    JetBrains Marketplace API at
    //    `https://plugins.jetbrains.com/api/plugins/<numeric-id>`):
    //      - 28264 "Codex Launcher" → com.github.x0x0b.codex-launcher
    //      - 31307 "Codex for JetBrains" → com.github.codexjb
    //      - 29342 "CC GUI (Claude or Codex)" → com.github.idea-claude-code-gui
    //
    // The binary + config-dir fallbacks downstream cover any install
    // method not represented here.
    private val candidatePlugins = listOf(
        PluginRef(id = "com.intellij.ml.llm", minVersion = "2025.3"),
        PluginRef(id = "com.github.x0x0b.codex-launcher"),
        PluginRef(id = "com.github.codexjb"),
        PluginRef(id = "com.github.idea-claude-code-gui"),
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
