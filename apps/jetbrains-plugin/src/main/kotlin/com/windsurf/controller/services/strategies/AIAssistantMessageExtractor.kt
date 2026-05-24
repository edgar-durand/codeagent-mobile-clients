package com.windsurf.controller.services.strategies

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import java.awt.Component
import java.awt.Container
import java.awt.Point
import java.util.concurrent.atomic.AtomicReference
import javax.accessibility.AccessibleContext
import javax.accessibility.AccessibleText
import javax.swing.SwingUtilities
import javax.swing.text.JTextComponent

/**
 * Extracts the latest assistant response from JetBrains AI Assistant
 * (the bundled "AIAssistant" tool window, plugin id `com.intellij.ml.llm`).
 *
 * Recent versions of AI Assistant render the conversation through a
 * mix of Swing and Compose Desktop. The pieces we care about are
 * Swing-native and reachable from the tool window's component tree:
 *
 *   • `com.intellij.ml.llm.core.chat.ui.chat.TextPartViewEditorPane`
 *       — a JEditorPane that holds the rendered markdown HTML for a
 *         text part. We feed it through `HtmlPaneToMarkdown` to recover
 *         markdown structure (lists, tables, headings, links, …).
 *   • `com.intellij.openapi.editor.impl.EditorComponentImpl`
 *       — embedded IntelliJ Editor instances used for code blocks. We
 *         pull `editor.document.text` and the file-type extension as
 *         the language tag for a fenced markdown code block.
 *
 * Compose-only nodes (plain text bubbles without a dedicated Swing
 * component) are picked up via the AccessibleContext fallback so
 * nothing visible is lost.
 *
 * Parts are ordered by the absolute Y coordinate of their root Swing
 * component, which gives us document order — top-to-bottom matches
 * chronological order in the chat. The user's own prompt is then
 * stripped (line-exact match) so we emit only the assistant's reply.
 *
 * `isDone` is reported as `null` — AI Assistant has no equivalent of
 * Copilot's "Completed" pill, so the monitor falls back to its
 * stability heuristic (no change for N polls = done).
 */
class AIAssistantMessageExtractor : MessageExtractor {

    private val logger = Logger.getInstance(AIAssistantMessageExtractor::class.java)

    private enum class PartType { TEXT, CODE }
    private data class MessagePart(
        val y: Int,
        val type: PartType,
        val content: String,
        val lang: String = "",
    )

    override fun extract(project: Project, toolWindow: ToolWindow, userPrompt: String): ExtractedMessage? {
        // The Swing scrape below is the only reliable read path: it
        // walks the TextPartViewEditorPane instances the chat panel
        // renders and converts their HTMLDocument to markdown. A
        // previous version called AIAssistantBridge.readLatestAssistantMessage
        // first, but every getter on ChatMessage we could reach
        // returned either non-text objects (ChatSessionImpl) or
        // arbitrary strings (UID) that mobile then displayed
        // verbatim. Until we identify a getter on the assistant
        // message subtype that actually carries the rendered markdown
        // (Markdown­ChatMessage.getDisplayText needs verifying in this
        // Codex build) we stick with the Swing scrape, which at
        // least produced legible plain text. The canonical-final
        // markdown emit will be added once the read path is solid.

        val ref = AtomicReference<ExtractedMessage?>(null)
        val app = ApplicationManager.getApplication()
        val task = Runnable {
            try {
                val parts = collectMessageParts(project, toolWindow)
                val md = if (parts.isNotEmpty()) {
                    renderParts(parts)
                } else {
                    // Fallback: agent rendered the message entirely in a
                    // Compose layer with no native Swing parts. Use the
                    // accessibility tree so we still capture *something*.
                    val composeRoot = findFirstByClassFragment(toolWindow, "JewelComposePanelWrapper")
                        ?: findFirstByClassFragment(toolWindow, "ComposePanel")
                        ?: return@Runnable
                    AIAssistantTextExtraction.collectAccessibleStrings(composeRoot)
                }
                if (md.isBlank()) return@Runnable
                val response = stripUserPrompt(md, userPrompt)
                if (response.isBlank()) return@Runnable
                ref.set(ExtractedMessage(response, isDone = null))
            } catch (e: Exception) {
                logger.debug("AI Assistant extract failed: ${e.message}")
            }
        }
        if (app.isDispatchThread) task.run() else {
            try { app.invokeAndWait(task) } catch (e: Exception) { logger.trace(e) }
        }
        return ref.get()
    }

    /**
     * Canonical-final markdown for the current turn, pulled from the
     * live ChatSession via reflection. Streaming chunks above come from
     * the Swing scrape, which flattens code blocks (no fences) and
     * tables (one cell per line). The bridge reads
     * `MarkdownChatMessage.getDisplayText()` on the last assistant
     * message, which is the same markdown the chat panel renders to
     * HTML — fences / tables / lists intact.
     *
     * The monitor uses this only at end-of-turn (when the stability
     * heuristic or an explicit done signal fires) and falls back to
     * the streaming snapshot if this returns null or implausibly short
     * text, so it can never make things worse than the streaming path.
     */
    override fun finalize(project: Project, toolWindow: ToolWindow, userPrompt: String): String? {
        return try {
            val raw = AIAssistantBridge.readLatestAssistantMessage(project) ?: return null
            val stripped = stripUserPrompt(raw, userPrompt)
            stripped.ifBlank { null }
        } catch (e: Exception) {
            logger.debug("AI Assistant finalize failed: ${e.message}")
            null
        }
    }

    // ---------------------------------------------------------------
    // Native Swing parts (preserves markdown structure)
    // ---------------------------------------------------------------

    private fun collectMessageParts(project: Project, tw: ToolWindow): List<MessagePart> {
        val parts = mutableListOf<MessagePart>()
        val toolWindowRoot = tw.contentManager.contents.firstOrNull()?.component ?: return parts

        // 1. Text parts — TextPartViewEditorPane is a JEditorPane the AI
        //    Assistant uses to render markdown HTML. The same component
        //    is reused for the *notification* banner ("The selected mode
        //    requires a new chat..."), so we must reject any pane that
        //    lives inside a `notification.PanelWithBackground` parent or
        //    we'd send the banner to mobile in place of the response.
        AIAssistantTextExtraction.walkSwing(toolWindowRoot) { c ->
            val cls = c.javaClass.name
            if (cls.endsWith(".TextPartViewEditorPane") && c is JTextComponent) {
                if (isInsideInputArea(c)) return@walkSwing
                if (isInsideNotification(c)) return@walkSwing
                val md = HtmlPaneToMarkdown.convert(c).trim()
                if (md.isNotBlank()) {
                    parts += MessagePart(AIAssistantTextExtraction.absoluteY(c, toolWindowRoot), PartType.TEXT, md)
                }
            }
        }

        // 2. Code parts — embedded IntelliJ Editors. EditorFactory tracks
        //    every live editor in the IDE; we filter to those whose Swing
        //    component lives under our tool window AND outside the input.
        for (editor in EditorFactory.getInstance().allEditors) {
            val ec = editor.component
            if (!SwingUtilities.isDescendingFrom(ec, toolWindowRoot)) continue
            if (isInsideInputArea(ec)) continue
            val text = editor.document.text.trimEnd('\n')
            if (text.isBlank()) continue
            parts += MessagePart(
                AIAssistantTextExtraction.absoluteY(ec, toolWindowRoot),
                PartType.CODE,
                text,
                lang = inferLanguageFromEditor(editor.document),
            )
        }

        parts.sortBy { it.y }
        return parts
    }

    /**
     * The AI Assistant chat shows banner notifications inside
     * `com.intellij.ml.llm.core.chat.ui.chat.notification.PanelWithBackground`,
     * and those banners reuse `TextPartViewEditorPane` to render their
     * text. We don't want to send banner text ("The selected mode
     * requires a new chat...") in place of the assistant's reply.
     */
    private fun isInsideNotification(c: Component): Boolean {
        var cur: Component? = c
        while (cur != null) {
            if (cur.javaClass.name.contains(".notification.")) return true
            cur = cur.parent
        }
        return false
    }

    private fun renderParts(parts: List<MessagePart>): String {
        val sb = StringBuilder()
        for (p in parts) {
            when (p.type) {
                PartType.TEXT -> sb.append(p.content).append("\n\n")
                PartType.CODE -> sb.append("\n```").append(p.lang).append("\n")
                    .append(p.content).append("\n```\n\n")
            }
        }
        return sb.toString().replace(Regex("\n{3,}"), "\n\n").trim()
    }

    /**
     * The AI Assistant input area also hosts an `EditorComponentImpl` (its
     * text-input field) and may host other text-pane children. We climb
     * the parent chain looking for any class whose name marks it as part
     * of the input — those nodes are NEVER message content.
     */
    private fun isInsideInputArea(c: Component): Boolean {
        var cur: Component? = c
        while (cur != null) {
            val name = cur.javaClass.name
            if (name.contains("AIAssistantInput") ||
                name.contains("ChatInput") ||
                name.contains(".input.")
            ) return true
            cur = cur.parent
        }
        return false
    }

    private fun inferLanguageFromEditor(doc: com.intellij.openapi.editor.Document): String {
        return try {
            val vf = FileDocumentManager.getInstance().getFile(doc) ?: return ""
            // Prefer the file extension (typescript / kotlin / python / …).
            val ext = vf.extension?.lowercase().orEmpty()
            if (ext.isNotBlank()) return ext
            // Fall back to the file type's name (Kotlin, Python, …) lowercased.
            vf.fileType.name.lowercase()
        } catch (_: Exception) {
            ""
        }
    }

    private fun findFirstByClassFragment(tw: ToolWindow, fragment: String): Component? {
        for (content in tw.contentManager.contents) {
            val component = content.component ?: continue
            val found = findFirstByClassFragment(component, fragment)
            if (found != null) return found
        }
        return null
    }

    private fun findFirstByClassFragment(root: Component, fragment: String): Component? {
        if (root.javaClass.name.contains(fragment)) return root
        if (root is Container) {
            for (i in 0 until root.componentCount) {
                val found = findFirstByClassFragment(root.getComponent(i), fragment)
                if (found != null) return found
            }
        }
        return null
    }

    // ---------------------------------------------------------------
    // AccessibleContext fallback (Compose-only messages)
    // ---------------------------------------------------------------

    /**
     * Strings the assistant's chrome inserts as standalone accessible
     * nodes — agent display name labels, transient streaming
     * indicators, etc. We never want them in the markdown we send to
     * mobile. Compared case-insensitively after whitespace collapsing.
     */

    /**
     * Drop everything up to and including the user's own prompt so the
     * chunk we emit is just the assistant's reply. Match by EXACT line
     * (case-insensitive) rather than `lastIndexOf` substring — when
     * the prompt is a common word like "Hola" the assistant's reply
     * often echoes it ("Hola. ¿En qué…"), and a substring match lands
     * inside the assistant's text and chops off its first word.
     */
    private fun stripUserPrompt(text: String, userPrompt: String): String {
        if (userPrompt.isBlank()) return text.trim()
        val needle = userPrompt.trim()
        val lines = text.split("\n")
        for (i in lines.indices.reversed()) {
            if (lines[i].trim().equals(needle, ignoreCase = true)) {
                return lines.drop(i + 1).joinToString("\n").trim()
            }
        }
        return text.trim()
    }
}
