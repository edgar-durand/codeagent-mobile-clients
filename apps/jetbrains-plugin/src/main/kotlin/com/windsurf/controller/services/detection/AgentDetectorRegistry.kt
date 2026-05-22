package com.windsurf.controller.services.detection

import com.windsurf.controller.services.DetectedAgent
import com.windsurf.controller.services.detection.detectors.CodexDetector

object AgentDetectorRegistry {
    /**
     * Detectors that produce DetectedAgent entries for the mobile picker.
     * The legacy 4-pass detection in `IdeIntegrationService` runs first;
     * this registry runs AFTER and only emits agents the legacy passes
     * don't already produce (currently: Codex).
     */
    val detectors: List<AgentDetector> = listOf(CodexDetector())

    suspend fun run(detectors: List<AgentDetector>, ctx: DetectionContext): List<DetectedAgent> {
        val out = mutableListOf<DetectedAgent>()
        for (d in detectors) {
            try {
                val r = d.detect(ctx) ?: continue
                out += toDetectedAgent(d, r)
            } catch (t: Throwable) {
                ctx.logger.warn("[agent-detection] ${d.id} threw: $t")
            }
        }
        return out
    }

    /**
     * Map a [DetectionResult] to the [DetectedAgent] wire shape. When the
     * detector matched a real plugin (via = EXTENSION), use the plugin id
     * verbatim as toolWindowId; otherwise emit the `__terminal__:<id>`
     * fallback so the mobile routes the agent through the CLI flow.
     */
    fun toDetectedAgent(d: AgentDetector, r: DetectionResult): DetectedAgent {
        val toolWindowId = if (r.via == DetectionResult.Via.EXTENSION) {
            r.extensionId
        } else {
            "__terminal__:${d.id}"
        }
        return DetectedAgent(
            id = d.id,
            name = d.name,
            pluginId = r.extensionId,
            toolWindowId = toolWindowId,
            icon = d.icon,
            installed = true,
        )
    }
}
