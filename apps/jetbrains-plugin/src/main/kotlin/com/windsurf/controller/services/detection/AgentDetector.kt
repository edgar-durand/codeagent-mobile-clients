package com.windsurf.controller.services.detection

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project

/**
 * Per-agent detection — mirror of the VS Code plugin's `AgentDetector`
 * interface. Every IDE-side agent visible to the mobile picker is
 * surfaced through one of these; there is no other detection path in
 * the plugin.
 *
 * A detector may emit zero, one, or multiple [DetectionResult]s — the
 * keyword-discovery detector returns the long-tail list of unknown
 * plugins that pattern-match without naming each one; specific
 * detectors return a single entry or none.
 */
interface AgentDetector {
    val id: String
    val name: String
    val icon: String

    suspend fun detect(ctx: DetectionContext): List<DetectionResult>
}

data class DetectionContext(
    val logger: Logger,
    /** Active project, when one is known. Detectors that probe tool
     *  windows on the EDT skip cleanly when this is null. */
    val project: Project? = null,
    /**
     * Plugin / extension ids already produced by earlier detectors in
     * this run. Catch-all detectors (keyword discovery) read this to
     * avoid double-emitting an agent a specific detector already
     * claimed.
     */
    val alreadyDetectedIds: Set<String> = emptySet(),
)

/**
 * Output of a single detection. Every field maps directly onto the
 * `DetectedAgent` wire shape — the registry's `toDetectedAgent` is a
 * structural copy, no transformation. Detectors that want the
 * `__terminal__:<id>` wire id set [isTerminalAgent] to true and the
 * registry composes the right toolWindowId.
 */
data class DetectionResult(
    val id: String,
    val name: String,
    val icon: String,
    val pluginId: String,
    val toolWindowId: String,
    val isTerminalAgent: Boolean = false,
)
