package com.windsurf.controller.services.detection

import com.windsurf.controller.services.DetectedAgent
import com.windsurf.controller.services.detection.checks.PluginRef
import com.windsurf.controller.services.detection.detectors.AiderDetector
import com.windsurf.controller.services.detection.detectors.ClaudeCodeDetector
import com.windsurf.controller.services.detection.detectors.CodeRabbitDetector
import com.windsurf.controller.services.detection.detectors.CodexDetector
import com.windsurf.controller.services.detection.detectors.CursorDetector
import com.windsurf.controller.services.detection.detectors.DynamicPluginDetector
import com.windsurf.controller.services.detection.detectors.DynamicToolWindowDetector
import com.windsurf.controller.services.detection.detectors.InIdeChatDetector

/**
 * Canonical detector list — every IDE-side agent visible to the
 * mobile picker is enumerated here, no inline detection logic
 * anywhere else in the plugin.
 *
 * Order matters:
 *   1. **Terminal agents first.** They emit deterministic
 *      `__terminal__:<id>` wire ids the mobile uses to route runtime
 *      commands to codeam-cli's pluginId.
 *   2. **Specific in-IDE chat agents** (JetBrains AI Assistant,
 *      Copilot, Windsurf / Codeium, Tabnine, Cody, Amazon Q, Junie,
 *      Cursor IDE).
 *   3. **Dynamic fallbacks** — plugin-id keyword discovery, then
 *      tool-window-id keyword discovery. These run last so they can
 *      consult `ctx.alreadyDetectedIds` and avoid double-emitting.
 */
object AgentDetectorRegistry {
    val detectors: List<AgentDetector> = listOf(
        // ─── Terminal agents (owned end-to-end by codeam-cli) ──────
        ClaudeCodeDetector(),
        CodexDetector(),
        CursorDetector(),
        CodeRabbitDetector(),
        AiderDetector(),

        // ─── In-IDE chat agents (the plugin drives their JCEF surface) ─
        InIdeChatDetector(
            id = "jetbrains-ai-assistant",
            name = "JetBrains AI Assistant",
            icon = "jetbrains-ai",
            candidatePlugins = listOf(PluginRef(id = "com.intellij.ai")),
            toolWindowIds = listOf("AIAssistant", "AI Assistant", "JetBrains AI Assistant"),
        ),
        InIdeChatDetector(
            id = "github-copilot",
            name = "GitHub Copilot",
            icon = "copilot",
            candidatePlugins = listOf(PluginRef(id = "com.github.copilot")),
            toolWindowIds = listOf("GitHub Copilot Chat"),
        ),
        InIdeChatDetector(
            id = "codeium-windsurf",
            name = "Codeium / Windsurf",
            icon = "codeium",
            candidatePlugins = listOf(PluginRef(id = "com.codeium.intellij")),
            toolWindowIds = listOf("Codeium Chat", "Codeium", "Cascade", "Windsurf"),
        ),
        InIdeChatDetector(
            id = "tabnine",
            name = "Tabnine",
            icon = "tabnine",
            candidatePlugins = listOf(PluginRef(id = "com.tabnine.TabNine")),
            toolWindowIds = listOf("Tabnine Chat", "Tabnine"),
        ),
        InIdeChatDetector(
            id = "amazon-q",
            name = "Amazon Q",
            icon = "amazon-q",
            candidatePlugins = listOf(PluginRef(id = "amazon.q")),
            toolWindowIds = listOf("Amazon Q", "Amazon Q Chat"),
        ),
        InIdeChatDetector(
            id = "sourcegraph-cody",
            name = "Sourcegraph Cody",
            icon = "cody",
            candidatePlugins = listOf(PluginRef(id = "com.sourcegraph.cody")),
            toolWindowIds = listOf("Cody", "Cody Chat"),
        ),
        InIdeChatDetector(
            id = "cursor-ide",
            name = "Cursor",
            icon = "cursor",
            candidatePlugins = listOf(PluginRef(id = "com.cursor.ide")),
            toolWindowIds = listOf("Cursor Chat", "Cursor"),
        ),
        InIdeChatDetector(
            id = "junie",
            name = "Junie",
            icon = "junie",
            candidatePlugins = listOf(PluginRef(id = "com.jetbrains.junie")),
            toolWindowIds = listOf("Junie"),
        ),

        // ─── Dynamic catch-alls (run last; read alreadyDetectedIds) ─
        DynamicPluginDetector(),
        DynamicToolWindowDetector(),
    )

    /**
     * Run [detectors] in order. Each detector receives a fresh
     * [DetectionContext] whose `alreadyDetectedIds` reflects every
     * id emitted by earlier detectors, so catch-alls can skip
     * duplicates. Returns the union, deduplicated by `id` (first
     * win) so a specific detector always beats a dynamic match.
     */
    suspend fun run(detectors: List<AgentDetector>, ctx: DetectionContext): List<DetectedAgent> {
        val out = mutableListOf<DetectedAgent>()
        val seen = mutableSetOf<String>()
        for (d in detectors) {
            try {
                val nextCtx = ctx.copy(alreadyDetectedIds = seen.toSet())
                for (r in d.detect(nextCtx)) {
                    if (r.id in seen) continue
                    seen += r.id
                    out += toDetectedAgent(r)
                }
            } catch (t: Throwable) {
                ctx.logger.warn("[agent-detection] ${d.id} threw: $t")
            }
        }
        return out
    }

    private fun toDetectedAgent(r: DetectionResult): DetectedAgent = DetectedAgent(
        id = r.id,
        name = r.name,
        pluginId = r.pluginId,
        toolWindowId = r.toolWindowId,
        icon = r.icon,
        installed = true,
    )
}
