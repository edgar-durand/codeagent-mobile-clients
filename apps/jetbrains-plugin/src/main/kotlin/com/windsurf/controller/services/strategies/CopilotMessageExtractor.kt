package com.windsurf.controller.services.strategies

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import java.awt.Component
import java.awt.Container
import java.util.concurrent.atomic.AtomicReference
import javax.swing.JLabel
import javax.swing.JTextField
import javax.swing.text.JTextComponent

/**
 * Extracts the latest assistant response from GitHub Copilot Chat.
 *
 * Copilot Chat in JetBrains is rendered ENTIRELY in Swing (no JCEF).
 * The conversation lives in well-named components from the
 * `com.github.copilot.agent.message` package:
 *
 *   • `CopilotAgentMessageComponent`           — outer container per message
 *   • `MessageContentBubble$…bubble$1`         — the bubble inside
 *   • `MessageContentPanel`                    — content host
 *     ├ `markdown.MarkdownPane`                — the response (HTMLDocument)
 *     ├ `contentRender.toolCallRenderers.ToolCallPanel` (× N) — tool calls
 *     └ `contentRender.ReferencesPanel`        — file references
 *   • `BottomLinePanel`                        — model badge + Completed pill
 *
 * We:
 *   1. Walk the tool window to collect every `CopilotAgentMessageComponent`.
 *   2. Pick the LAST one whose subtree yields non-empty markdown
 *      (skips user-echo bubbles that have no `MarkdownPane`).
 *   3. Convert each `MarkdownPane`'s live `HTMLDocument` to markdown by
 *      walking its element tree — entities are decoded by Swing's HTML
 *      parser, so we never touch raw `&#x27;`/`&amp;` strings.
 *   4. Detect "Completed" by reading the bubble's `BottomLinePanel`.
 */
class CopilotMessageExtractor : MessageExtractor {

    private val logger = Logger.getInstance(CopilotMessageExtractor::class.java)

    /**
     * Number of `CopilotAgentMessageComponent` bubbles present in the
     * chat at the moment we started watching for the current turn.
     * Anything at index < `baseline` is part of an earlier conversation
     * and must NOT be reported as the response to the current prompt.
     * `-1` means "not initialised yet" — the first `extract` call
     * doubles as initialisation if `resetForNewTurn` wasn't invoked
     * (defensive: works even if the monitor forgets to call it).
     */
    private var baselineBubbleCount: Int = -1

    override fun resetForNewTurn(toolWindow: ToolWindow) {
        baselineBubbleCount = countBubblesOnEdt(toolWindow)
    }

    override fun extract(project: Project, toolWindow: ToolWindow, userPrompt: String): ExtractedMessage? {
        val ref = AtomicReference<ExtractedMessage?>(null)
        val app = ApplicationManager.getApplication()
        val task = Runnable {
            try {
                val bubbles = mutableListOf<Component>()
                for (c in toolWindow.contentManager.contents) {
                    collectMessageBubbles(c.component, bubbles)
                }
                if (bubbles.isEmpty()) return@Runnable

                if (baselineBubbleCount < 0) {
                    // Lazy init — `resetForNewTurn` wasn't called.
                    // Treat every existing bubble as "old".
                    baselineBubbleCount = bubbles.size
                    return@Runnable
                }

                // We want bubbles introduced by THIS turn. If Copilot
                // added bubbles (count grew), only consider the new
                // tail. If Copilot reused the trailing bubble in place
                // (count didn't grow), scan everything and let the
                // user-prompt filter below skip the user's own echo.
                val lowerBound = if (bubbles.size > baselineBubbleCount) baselineBubbleCount else 0
                val promptTrimmed = userPrompt.trim()
                for (i in bubbles.indices.reversed()) {
                    if (i < lowerBound) break
                    val bubble = bubbles[i]
                    val sb = StringBuilder()
                    walkBubble(bubble, sb)
                    val md = sb.toString().replace(Regex("\\n{3,}"), "\n\n").trim()
                    if (md.isBlank()) continue

                    // Copilot wraps user and assistant turns in the
                    // same `CopilotAgentMessageComponent`; the user
                    // bubble's markdown equals the prompt verbatim.
                    if (promptTrimmed.isNotBlank() &&
                        (md == promptTrimmed || md.equals(promptTrimmed, ignoreCase = true))
                    ) {
                        continue
                    }

                    // Plan / quota error sometimes renders inline in
                    // the assistant bubble instead of firing through
                    // the `onError` callback. Capture it for the
                    // metadata bridge so mobile/web shows the same
                    // banner the CLI shows for Claude rate limits.
                    if (CopilotChatBridge.looksLikeQuotaError(md)) {
                        CopilotChatBridge.lastQuotaError = md
                    }

                    ref.set(ExtractedMessage(md, detectDone(bubble)))
                    return@Runnable
                }
            } catch (e: Exception) {
                logger.debug("Copilot extract failed: ${e.message}")
            }
        }
        if (app.isDispatchThread) task.run() else {
            try { app.invokeAndWait(task) } catch (_: Exception) {}
        }
        return ref.get()
    }

    private fun countBubblesOnEdt(toolWindow: ToolWindow): Int {
        val app = ApplicationManager.getApplication()
        val ref = AtomicReference(0)
        val task = Runnable {
            val bubbles = mutableListOf<Component>()
            for (c in toolWindow.contentManager.contents) {
                collectMessageBubbles(c.component, bubbles)
            }
            ref.set(bubbles.size)
        }
        if (app.isDispatchThread) task.run() else try {
            app.invokeAndWait(task)
        } catch (_: Exception) {}
        return ref.get()
    }

    private fun collectMessageBubbles(root: Component, out: MutableList<Component>) {
        if (root.javaClass.name == "com.github.copilot.agent.message.CopilotAgentMessageComponent") {
            out.add(root)
            // Don't recurse INTO the bubble — its descendants are part of THIS message.
            return
        }
        if (root is Container) {
            for (i in 0 until root.componentCount) {
                collectMessageBubbles(root.getComponent(i), out)
            }
        }
    }

    private fun walkBubble(root: Component, sb: StringBuilder) {
        val cls = root.javaClass.name
        when {
            cls.endsWith(".MarkdownPane") -> {
                if (root is JTextComponent) {
                    val md = HtmlPaneToMarkdown.convert(root)
                    if (md.isNotBlank()) sb.append(md).append("\n\n")
                }
                return
            }
            cls.endsWith(".ToolCallPanel") -> {
                val txt = collectVisibleText(root).trim()
                if (txt.isNotBlank()) {
                    // One quoted line per tool call so the mobile renderer
                    // shows it as a distinct step in the markdown view.
                    sb.append("> ").append(txt.replace("\n", " ")).append("\n\n")
                }
                return
            }
            cls.endsWith(".ReferencesPanel") || cls.endsWith(".ReferenceListPanel") -> {
                // Collapsed in the IDE — skip on mobile too.
                return
            }
            cls.endsWith(".BottomLinePanel") -> {
                // Model badge / status — skip from the response markdown.
                return
            }
        }
        if (root is Container) {
            for (i in 0 until root.componentCount) {
                walkBubble(root.getComponent(i), sb)
            }
        }
    }

    private fun detectDone(bubble: Component): Boolean {
        val ref = AtomicReference<String?>(null)
        fun walk(c: Component) {
            if (ref.get() != null) return
            if (c.javaClass.name.endsWith(".BottomLinePanel")) {
                ref.set(collectVisibleText(c).lowercase())
                return
            }
            if (c is Container) {
                for (i in 0 until c.componentCount) walk(c.getComponent(i))
            }
        }
        walk(bubble)
        val txt = ref.get() ?: return false
        if (txt.contains("generating") || txt.contains("stop")) return false
        return txt.contains("completed")
    }

    private fun collectVisibleText(root: Component): String {
        val sb = StringBuilder()
        fun walk(c: Component) {
            when (c) {
                is JLabel -> {
                    val t = c.text
                    if (!t.isNullOrBlank()) sb.append(stripHtml(t)).append(" ")
                }
                is JTextComponent -> {
                    if (c !is JTextField) {
                        val t = c.text
                        if (!t.isNullOrBlank()) sb.append(stripHtml(t)).append(" ")
                    }
                }
            }
            if (c is Container) {
                for (i in 0 until c.componentCount) walk(c.getComponent(i))
            }
        }
        walk(root)
        return sb.toString().trim()
    }

    /** Minimal HTML→text used only for Swing label text. */
    private fun stripHtml(html: String): String =
        html.replace(Regex("(?is)<script[^>]*>.*?</script>"), " ")
            .replace(Regex("(?is)<style[^>]*>.*?</style>"), " ")
            .replace(Regex("<br\\s*/?>", RegexOption.IGNORE_CASE), "\n")
            .replace(Regex("</(?:p|div|h[1-6]|li|tr)>", RegexOption.IGNORE_CASE), "\n")
            .replace(Regex("<[^>]+>"), " ")
            .replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
            .replace("&quot;", "\"").replace("&#39;", "'").replace("&nbsp;", " ")
            .replace(Regex("[ \\t]+"), " ")
            .replace(Regex("\\n{3,}"), "\n\n")
            .trim()

}
