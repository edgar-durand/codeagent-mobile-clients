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
}
