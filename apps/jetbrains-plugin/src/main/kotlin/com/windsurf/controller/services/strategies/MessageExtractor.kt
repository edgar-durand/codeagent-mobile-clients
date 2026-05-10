package com.windsurf.controller.services.strategies

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow

/**
 * One captured snapshot of an assistant's response.
 *
 * @property markdown the latest visible response, in GitHub-flavored
 *           markdown so the mobile renderer can produce its rich
 *           components (code fences, lists, tables, links, …).
 * @property isDone three-state done signal:
 *           - `true`  when the agent's UI explicitly shows the response
 *             is complete (e.g. Copilot's "Completed" pill).
 *           - `false` while the agent is still generating.
 *           - `null`  when the extractor can't tell — the monitor will
 *             fall back to its stability heuristic (no change for
 *             N polls = done).
 */
data class ExtractedMessage(
    val markdown: String,
    val isDone: Boolean?,
)

/**
 * Per-agent capture seam. An extractor knows how to read ONE specific
 * agent's UI (Copilot's Swing bubbles, AI Assistant's Compose scene,
 * a JCEF-rendered chat, a terminal, …) and produce the latest response
 * as markdown.
 *
 * Implementations are responsible for any EDT bouncing they need —
 * `extract` may be called from any thread, must return promptly, and
 * must NOT mutate the agent's UI.
 *
 * The shared `AgentOutputMonitor` owns the polling loop, the dedup
 * state (last-sent markdown, stability counter), the chunk push
 * protocol, and the new-turn lifecycle. The extractor stays stateless.
 */
interface MessageExtractor {
    fun extract(project: Project, toolWindow: ToolWindow, userPrompt: String): ExtractedMessage?

    /**
     * Per-turn lifecycle hook. Called by `AgentOutputMonitor` between
     * turns so the extractor can record a baseline of the chat (bubble
     * count, last-seen message id, etc.) and avoid reporting messages
     * that already existed before the new prompt was sent. Default is
     * a no-op — extractors that don't need turn isolation can ignore
     * it.
     *
     * Why this exists: Copilot's chat may take 100–500 ms to mount the
     * new assistant bubble after a prompt is dispatched. During that
     * gap, the previous turn's bubble is still the "last bubble with
     * markdown", so a naive "report the last non-empty bubble" loop
     * re-reports the previous turn's response as though it were the
     * answer to the current prompt. The extractor uses this hook to
     * remember "everything before this point is old" and only report
     * bubbles that materialise afterwards.
     */
    fun resetForNewTurn(toolWindow: ToolWindow) {
        // no-op default
    }
}
