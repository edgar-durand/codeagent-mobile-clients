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
                    collectAccessibleStrings(composeRoot)
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
            try { app.invokeAndWait(task) } catch (_: Exception) {}
        }
        return ref.get()
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
        walkSwing(toolWindowRoot) { c ->
            val cls = c.javaClass.name
            if (cls.endsWith(".TextPartViewEditorPane") && c is JTextComponent) {
                if (isInsideInputArea(c)) return@walkSwing
                if (isInsideNotification(c)) return@walkSwing
                val md = HtmlPaneToMarkdown.convert(c).trim()
                if (md.isNotBlank()) {
                    parts += MessagePart(absoluteY(c, toolWindowRoot), PartType.TEXT, md)
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
                absoluteY(ec, toolWindowRoot),
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

    private fun walkSwing(root: Component, visit: (Component) -> Unit) {
        visit(root)
        if (root is Container) {
            for (i in 0 until root.componentCount) walkSwing(root.getComponent(i), visit)
        }
    }

    private fun absoluteY(c: Component, root: Component): Int {
        return try {
            val p = SwingUtilities.convertPoint(c, Point(0, 0), root)
            p.y
        } catch (_: Exception) {
            0
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
     * Walk the AccessibleContext tree of `root` and collect distinct
     * strings, ONE entry per node. Compose Desktop maps every Text
     * composable to an AccessibleContext whose `accessibleName`
     * carries the rendered text — using only that field avoids the
     * triple-emission bug where the same paragraph showed up as
     * (a) accessibleName, (b) AccessibleText sentence 1, plus
     * (c) AccessibleText sentence 2, all on the mobile UI.
     *
     * Walks ONLY via `accessibleChildren` (Compose's semantics tree).
     * Visiting Swing children too would re-enter the same nodes via
     * two paths and reintroduce the duplicates we just fixed.
     */
    private fun collectAccessibleStrings(root: Component): String {
        val sb = StringBuilder()
        val seen = HashSet<String>()
        fun appendUnique(s: String?) {
            val text = s?.trim().orEmpty()
            if (text.isEmpty()) return
            if (seen.add(text)) sb.append(text).append('\n')
        }
        fun visit(ctx: AccessibleContext, depth: Int) {
            if (depth > 80) return
            try {
                val name = ctx.accessibleName
                if (!name.isNullOrBlank()) {
                    appendUnique(name)
                } else {
                    val at = ctx.accessibleText
                    if (at != null && at.charCount > 0) {
                        val full = StringBuilder()
                        var idx = 0
                        var safety = 0
                        while (idx < at.charCount && safety < 1000) {
                            val seg = at.getAtIndex(AccessibleText.SENTENCE, idx) ?: break
                            full.append(seg)
                            idx += seg.length.coerceAtLeast(1)
                            safety++
                        }
                        appendUnique(full.toString())
                    }
                }
                for (i in 0 until ctx.accessibleChildrenCount) {
                    val child = ctx.getAccessibleChild(i) ?: continue
                    val childCtx = child.accessibleContext ?: continue
                    visit(childCtx, depth + 1)
                }
            } catch (_: Exception) { /* tolerate accessibility quirks */ }
        }
        val rootCtx = root.accessibleContext ?: return ""
        visit(rootCtx, 0)
        return sb.toString().trim()
    }

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
