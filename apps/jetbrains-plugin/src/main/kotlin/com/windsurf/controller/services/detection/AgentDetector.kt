package com.windsurf.controller.services.detection

import com.intellij.openapi.diagnostic.Logger

/**
 * Per-agent detection — mirrors the VS Code plugin's `AgentDetector`
 * interface. Each detector encapsulates the checks that decide whether
 * an agent counts as installed and returns one [DetectionResult] (null
 * when not detected). The registry composes results into
 * [com.windsurf.controller.services.DetectedAgent] instances for the
 * mobile picker.
 *
 * Note: unlike the VS Code plugin where the registry now owns Claude
 * Code detection, the JetBrains plugin keeps Claude in the legacy
 * 4-pass logic inside `IdeIntegrationService.detectInstalledAgents`.
 * The registry is only used for NEW detectors (Codex, future agents)
 * whose detection logic doesn't already live in the legacy passes.
 */
interface AgentDetector {
    val id: String
    val name: String
    val icon: String

    suspend fun detect(ctx: DetectionContext): DetectionResult?
}

data class DetectionContext(
    val logger: Logger,
)

data class DetectionResult(
    val extensionId: String,
    val via: Via,
) {
    enum class Via { EXTENSION, BINARY, CONFIG_DIR, TERMINAL_TAB }
}
