package com.windsurf.controller.services.detection.detectors

import com.windsurf.controller.services.detection.AgentDetector
import com.windsurf.controller.services.detection.DetectionContext
import com.windsurf.controller.services.detection.DetectionResult
import com.windsurf.controller.services.detection.checks.PluginRef
import com.windsurf.controller.services.detection.checks.findInstalledPlugin
import com.windsurf.controller.services.detection.checks.findOpenToolWindowId

/**
 * Generic in-IDE chat-agent detector — covers every JCEF / Swing
 * chat surface the plugin's `AgentOutputMonitor` + strategy registry
 * can drive (AI Assistant, Copilot Chat, Windsurf / Codeium / Cascade,
 * Tabnine, Cody, Amazon Q, Junie, Cursor IDE).
 *
 * Detection signals (any positive → installed):
 *   1. One of [candidatePlugins] is installed and enabled.
 *   2. One of [toolWindowIds] is currently registered in the active
 *      project (covers plugins with non-deterministic ids).
 *
 * When the tool window resolves, that becomes the emitted
 * `toolWindowId` — strategies dispatch by tool-window name. When only
 * the plugin matches, the first candidate tool-window id is used as
 * a stable default.
 *
 * Distinct from the terminal-agent detectors (Claude / Codex / Cursor
 * CLI / CodeRabbit / Aider): no `__terminal__:` prefix, no
 * `isTerminalAgent = true`. These agents run inside the IDE and the
 * plugin drives their JCEF surface directly.
 */
class InIdeChatDetector(
    override val id: String,
    override val name: String,
    override val icon: String,
    private val candidatePlugins: List<PluginRef>,
    private val toolWindowIds: List<String>,
) : AgentDetector {

    override suspend fun detect(ctx: DetectionContext): List<DetectionResult> {
        val plugin = findInstalledPlugin(candidatePlugins)
        val resolvedTw = ctx.project?.let { findOpenToolWindowId(it, toolWindowIds) }
        if (plugin == null && resolvedTw == null) return emptyList()
        val pluginId = plugin?.id ?: candidatePlugins.firstOrNull()?.id ?: id
        val twId = resolvedTw ?: toolWindowIds.firstOrNull() ?: id
        ctx.logger.info("[InIdeChatDetector:$id] detected (plugin=${plugin?.id ?: "none"}, tw=$twId)")
        return listOf(
            DetectionResult(
                id = pluginId,
                name = name,
                icon = icon,
                pluginId = pluginId,
                toolWindowId = twId,
                isTerminalAgent = false,
            ),
        )
    }
}
