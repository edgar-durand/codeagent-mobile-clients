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
     * Strings the assistant's chrome inserts as standalone accessible
     * nodes — agent display name labels, transient streaming
     * indicators, etc. We never want them in the markdown we send to
     * mobile. Compared case-insensitively after whitespace collapsing.
     */
    private val CHROME_LABELS = setOf(
        "thinking…", "thinking...", "generating…", "generating...",
        "stop", "stop generating", "loading…", "loading...",
    )

    /**
     * Walk the AccessibleContext tree of `root` and collect distinct
     * markdown content. Compose Desktop maps every Text composable to
     * an AccessibleContext, with tables exposing `AccessibleTable`
     * which we use to reconstruct GFM table markdown (otherwise each
     * cell would emit as a separate line). The walker also:
     *
     *   • follows ONLY `accessibleChildren` (Compose's semantics tree)
     *     and tracks `visited` by identity hash so a node referenced
     *     from multiple paths is only handled once — fixes the
     *     "everything emitted twice" duplication on mobile.
     *   • drops known chrome strings ("Thinking…", "Generating…", …)
     *     after whitespace normalisation, since Compose retains those
     *     transient nodes in the layout even after the response
     *     arrives.
     *   • normalises whitespace (incl. NBSP / zero-width) before
     *     dedup so visually-identical strings collapse correctly.
     *
     * Note: an earlier draft also filtered by
     * `AccessibleState.SHOWING`, but Compose Desktop's root
     * `JewelComposePanelWrapper.accessibleContext` doesn't expose
     * that state — the filter killed the very first node we visited,
     * the walker never recursed, and the mobile app sat at "Agent is
     * responding…" forever with no chunks ever flowing.
     */
    private fun collectAccessibleStrings(root: Component): String {
        val sb = StringBuilder()
        val seen = HashSet<String>()
        val visited = HashSet<Int>()
        val whitespace = Regex("[\\s\\u00A0\\u200B\\u200C\\u200D]+")

        // PRE-STEP: try to reconstruct a table by grouping accessibility
        // leaves on their absolute Y coordinate.
        //
        // Why this helps: in Codex's Compose Desktop renderer the chat
        // bubble exposes table cells as a FLAT list of accessibility
        // leaves with the same parent (the standard `detectComposeTable`
        // below expects N children with M leaves each — Codex gives us
        // K=N×M children at the same level, so the heuristic misses).
        // But each cell still has its own on-screen Y coordinate. Cells
        // in the same visual row share Y; grouping by Y reconstructs
        // the row layout exactly.
        //
        // If the grouping yields ≥ 2 rows × ≥ 2 columns AND every row
        // has the same column count, we emit markdown table syntax
        // directly and skip the depth-first walker (which would
        // re-emit each cell on its own line).
        val tableMarkdown = tryReconstructTableByY(root, whitespace)
        if (tableMarkdown != null) return tableMarkdown

        fun appendUnique(s: String?) {
            val text = s?.replace(whitespace, " ")?.trim().orEmpty()
            if (text.isEmpty()) return
            if (text.lowercase() in CHROME_LABELS) return
            if (seen.add(text)) sb.append(text).append('\n')
        }
        fun emitTable(table: javax.accessibility.AccessibleTable) {
            val rows = table.accessibleRowCount
            val cols = table.accessibleColumnCount
            if (rows <= 0 || cols <= 0) return
            fun cell(r: Int, c: Int): String = try {
                val a = table.getAccessibleAt(r, c) ?: return ""
                a.accessibleContext?.accessibleName
                    ?.replace(whitespace, " ")?.trim()
                    ?.replace("|", "\\|")
                    ?: ""
            } catch (_: Exception) { "" }
            sb.append("\n")
            sb.append("| ").append((0 until cols).joinToString(" | ") { cell(0, it) }).append(" |\n")
            sb.append("|").append((0 until cols).joinToString("|") { " --- " }).append("|\n")
            for (r in 1 until rows) {
                sb.append("| ").append((0 until cols).joinToString(" | ") { cell(r, it) }).append(" |\n")
            }
            sb.append("\n")
            // Mark every cell's text as seen so it doesn't re-emit later
            // when the walker descends into the same Text composables.
            for (r in 0 until rows) for (c in 0 until cols) {
                seen.add(cell(r, c).replace("\\|", "|"))
            }
        }
        /**
         * Recursively collect every leaf accessible-text under `ctx`.
         * "Leaf" = a context with zero accessibleChildren whose
         * `accessibleName` is non-empty. Used by the table heuristic
         * so cells wrapped in extra Compose containers
         * (Row → Box → Padding → Text) still count as one cell.
         */
        fun collectLeafTexts(ctx: AccessibleContext): List<String> {
            val out = mutableListOf<String>()
            fun walk(c: AccessibleContext, d: Int) {
                if (d > 10) return
                val n = c.accessibleChildrenCount
                if (n == 0) {
                    val name = c.accessibleName?.replace(whitespace, " ")?.trim().orEmpty()
                    if (name.isNotEmpty()) out.add(name)
                    return
                }
                for (i in 0 until n) {
                    val sub = c.getAccessibleChild(i)?.accessibleContext ?: continue
                    walk(sub, d + 1)
                }
            }
            walk(ctx, 0)
            return out
        }

        /**
         * Heuristic table detection for Compose Desktop. Compose
         * builds tables with `Column { Row { Cell × M } }` and does
         * NOT expose `AccessibleTable` for them, so the standard
         * branch below misses them and the walker emits each cell as
         * a separate line on the mobile UI.
         *
         * If a node has K ≥ 2 children whose subtrees each yield the
         * SAME number M ≥ 2 of leaf-text descendants and every cell
         * is non-empty, treat it as an M-column table. Walking each
         * child's subtree (instead of only direct grandchildren)
         * tolerates extra Compose wrapper layers (Box/Padding/etc.)
         * between Row and Cell.
         *
         * Returns markdown rows when detected, `null` otherwise.
         */
        fun detectComposeTable(ctx: AccessibleContext): List<List<String>>? {
            val n = ctx.accessibleChildrenCount
            if (n < 2) return null
            val rows = mutableListOf<List<String>>()
            for (i in 0 until n) {
                val rowCtx = ctx.getAccessibleChild(i)?.accessibleContext ?: return null
                val leaves = collectLeafTexts(rowCtx)
                if (leaves.size < 2) return null
                rows += leaves.map { it.replace("|", "\\|") }
            }
            val firstSize = rows[0].size
            if (rows.any { it.size != firstSize }) return null
            // Sanity: distinct content. If every row collapses to the
            // same N strings, this is probably not a real table —
            // could be a navigation rail repeating per item.
            if (rows.size >= 2 && rows.toSet().size == 1) return null
            logger.info("AI Assistant: detected ${rows.size}×$firstSize table heuristically")
            return rows
        }

        fun emitDetectedTable(rows: List<List<String>>, ctx: AccessibleContext) {
            val cols = rows[0].size
            sb.append("\n")
            sb.append("| ").append(rows[0].joinToString(" | ")).append(" |\n")
            sb.append("|").append((0 until cols).joinToString("|") { " --- " }).append("|\n")
            for (i in 1 until rows.size) {
                sb.append("| ").append(rows[i].joinToString(" | ")).append(" |\n")
            }
            sb.append("\n")
            // Mark every cell text as seen so the walker doesn't re-emit
            // them as standalone lines when it later visits the cell
            // composables individually.
            for (row in rows) for (cell in row) seen.add(cell.replace("\\|", "|"))
            // Also mark every descendant context as visited so the walker
            // doesn't re-enter the table's interior via accessibleChildren.
            fun markVisited(c: AccessibleContext) {
                visited.add(System.identityHashCode(c))
                for (i in 0 until c.accessibleChildrenCount) {
                    val sub = c.getAccessibleChild(i)?.accessibleContext ?: continue
                    markVisited(sub)
                }
            }
            markVisited(ctx)
        }

        fun visit(ctx: AccessibleContext, depth: Int) {
            if (depth > 80) return
            if (!visited.add(System.identityHashCode(ctx))) return
            try {
                // Standard accessibility table (rare for Compose Desktop
                // but kept for any future agent that exposes one).
                val asTable = ctx.accessibleTable
                if (asTable != null) {
                    emitTable(asTable)
                    return
                }

                // Compose Desktop fallback — pattern-match a uniform grid.
                val composeTable = detectComposeTable(ctx)
                if (composeTable != null) {
                    emitDetectedTable(composeTable, ctx)
                    return
                }

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
     * Walk the accessibility tree, collect every leaf with its absolute
     * Y coordinate, then group leaves whose Y values cluster (within
     * `tolerance` pixels) into rows. If we end up with a clean N×M
     * grid (≥2 rows, ≥2 cols, every row same width, every cell
     * non-empty), render it as a GFM markdown table.
     *
     * Returns null if the leaves don't form a clean grid — caller
     * falls back to the normal flat-list emission.
     */
    private data class GridLeaf(val text: String, val y: Int, val x: Int)

    /**
     * Collect every accessibility leaf in `root` with its absolute
     * screen X/Y, group adjacent leaves by Y (tolerance 6 px), then
     * classify each "line" as one of:
     *   • table row (≥2 cells on the same Y)
     *   • code      (single cell whose content looks like source)
     *   • plain text
     *
     * The output stitches consecutive same-type runs into the right
     * markdown construct: tables get `| … |` rows + `---` divider,
     * code runs get triple-backtick fences with a detected language,
     * and plain text is emitted as paragraphs.
     *
     * Returns null only when the leaves don't contain anything richer
     * than a single paragraph — caller falls back to the unstructured
     * walker. The previous version of this function only handled
     * tables; once `looksLikeCode` started firing, callers also get
     * proper fenced code blocks (Java / Python / JS / etc.) instead of
     * the previous flattened-on-one-line plain text.
     */
    private fun tryReconstructTableByY(root: Component, whitespace: Regex): String? {
        val leaves = mutableListOf<GridLeaf>()
        val visited = HashSet<Int>()
        val rootCtx = root.accessibleContext ?: return null

        var sawAnyBounds = 0
        var sawScreenLoc = 0
        fun visit(ctx: AccessibleContext, depth: Int, accumulatedX: Int, accumulatedY: Int) {
            if (depth > 80) return
            if (!visited.add(System.identityHashCode(ctx))) return
            try {
                val comp = ctx.accessibleComponent
                var ownX = accumulatedX
                var ownY = accumulatedY
                if (comp != null) {
                    try {
                        val loc = comp.locationOnScreen
                        ownX = loc.x; ownY = loc.y; sawScreenLoc++
                    } catch (_: Exception) {
                        try {
                            val b = comp.bounds
                            ownX = b.x + accumulatedX; ownY = b.y + accumulatedY
                            sawAnyBounds++
                        } catch (_: Exception) { /* keep accumulated */ }
                    }
                }
                val n = ctx.accessibleChildrenCount
                if (n == 0) {
                    val raw = ctx.accessibleName?.replace(whitespace, " ")?.trim().orEmpty()
                    if (raw.isEmpty()) return
                    if (raw.lowercase() in CHROME_LABELS) return
                    leaves.add(GridLeaf(raw, ownY, ownX))
                    return
                }
                for (i in 0 until n) {
                    val sub = ctx.getAccessibleChild(i)?.accessibleContext ?: continue
                    visit(sub, depth + 1, ownX, ownY)
                }
            } catch (_: Exception) { /* tolerate */ }
        }
        visit(rootCtx, 0, 0, 0)

        if (leaves.size < 2) {
            logger.info("tryReconstructTableByY: ${leaves.size} leaves collected (need ≥2) screenLoc=$sawScreenLoc bounds=$sawAnyBounds")
            return null
        }

        // Group by Y with tolerance, then sort each line left-to-right
        // by X so column order matches the visual layout.
        val tolerance = 6
        val lines = mutableListOf<MutableList<GridLeaf>>()
        var currentY = Int.MIN_VALUE
        var currentLine: MutableList<GridLeaf>? = null
        for (leaf in leaves) {
            if (currentLine == null || kotlin.math.abs(leaf.y - currentY) > tolerance) {
                currentLine = mutableListOf()
                lines.add(currentLine)
            }
            currentLine.add(leaf)
            currentY = leaf.y
        }
        lines.forEach { it.sortBy { l -> l.x } }

        val lineSizes = lines.map { it.size }
        logger.info("tryReconstructTableByY: ${leaves.size} leaves → ${lines.size} lines, sizes=${lineSizes.take(20)}")

        // Classify-and-emit pass. Walk lines in order; when we see a
        // multi-cell line, greedily consume same-width neighbours as a
        // table. When we see a single code-like line, greedily consume
        // adjacent code-like lines as a fenced block. Everything else
        // is plain text.
        val sb = StringBuilder()
        fun escape(s: String) = s.replace("|", "\\|")
        var emittedSomething = false
        var i = 0
        while (i < lines.size) {
            val firstSize = lines[i].size
            if (firstSize >= 2) {
                var j = i + 1
                while (j < lines.size && lines[j].size == firstSize) j++
                val run = lines.subList(i, j)
                val rows = run.map { line -> line.map { it.text } }
                if (run.size >= 2 && rows.toSet().size > 1) {
                    if (emittedSomething) sb.append("\n")
                    sb.append("| ").append(rows[0].joinToString(" | ") { escape(it) }).append(" |\n")
                    sb.append("|").append((0 until firstSize).joinToString("|") { " --- " }).append("|\n")
                    for (r in 1 until rows.size) {
                        sb.append("| ").append(rows[r].joinToString(" | ") { escape(it) }).append(" |\n")
                    }
                    emittedSomething = true
                    i = j
                    continue
                }
                // Multi-cell but only one row — treat as space-joined text.
                if (emittedSomething) sb.append("\n")
                sb.append(rows[0].joinToString(" ")).append("\n")
                emittedSomething = true
                i++
                continue
            }
            // Single-cell line.
            val text = lines[i][0].text
            // Diff blocks: consume ≥2 consecutive diff-shaped lines
            // (lines starting with `+`/`-`/` ` followed by content,
            // or hunk headers `@@ … @@`).
            if (looksLikeDiff(text)) {
                val diffLines = mutableListOf<String>()
                var j = i
                while (j < lines.size && lines[j].size == 1 && looksLikeDiff(lines[j][0].text)) {
                    diffLines.add(lines[j][0].text)
                    j++
                }
                if (diffLines.size >= 2) {
                    if (emittedSomething) sb.append("\n")
                    sb.append("```diff\n")
                    sb.append(diffLines.joinToString("\n"))
                    sb.append("\n```\n")
                    emittedSomething = true
                    i = j
                    continue
                }
                // Only one diff-shaped line — fall through to plain text.
            }
            if (looksLikeCode(text)) {
                // Consume consecutive code-like lines into one fence.
                val codeLines = mutableListOf<String>()
                var j = i
                while (j < lines.size && lines[j].size == 1 && looksLikeCode(lines[j][0].text)) {
                    codeLines.add(reflowCodeLine(lines[j][0].text))
                    j++
                }
                val lang = detectCodeLang(codeLines.joinToString("\n"))
                if (emittedSomething) sb.append("\n")
                sb.append("```").append(lang).append("\n")
                sb.append(codeLines.joinToString("\n"))
                sb.append("\n```\n")
                emittedSomething = true
                i = j
                continue
            }
            if (emittedSomething) sb.append("\n")
            sb.append(text).append("\n")
            emittedSomething = true
            i++
        }
        return sb.toString().trim().ifBlank { null }
    }

    /**
     * A line looks like part of a unified diff if it starts with
     * `+`, `-`, or ` ` followed by content (the standard diff payload
     * prefix), or with a hunk header `@@ … @@`, or with
     * `diff --git`. Used to detect a run of diff lines that should be
     * fenced as ```diff so mobile gets red/green highlighting.
     */
    private fun looksLikeDiff(text: String): Boolean {
        if (text.length < 2) return false
        if (text.startsWith("@@") && text.indexOf("@@", startIndex = 2) >= 0) return true
        if (text.startsWith("diff --git ")) return true
        if (text.startsWith("--- ") || text.startsWith("+++ ")) return true
        val first = text[0]
        if (first != '+' && first != '-' && first != ' ') return false
        // Bare "+" or "-" alone (single char) is more likely an emoji /
        // bullet — require some content after the marker.
        if (text.length < 3) return false
        return text[1] == ' ' || text[1].isLetterOrDigit() || text[1] in "({/_\""
    }

    /**
     * Heuristic test: does this single-line cell look like source code?
     *
     * Triggers on a combination of length + density of code punctuation
     * (`{` `}` `;` `()`) plus one strong syntactic marker
     * (`class`, `function`, `def`, `import`, `public`, …). Tuned to
     * fire on a one-line flattened Java/JS/Python snippet (the
     * accessibility tree collapses code blocks into a single leaf)
     * while NOT firing on prose paragraphs that happen to contain
     * parentheses or semicolons.
     */
    private fun looksLikeCode(text: String): Boolean {
        if (text.length < 25) return false
        val punctCount =
            text.count { it == '{' || it == '}' || it == ';' } +
            text.count { it == '(' } / 2  // each call has ( + ); count once
        val hasKeyword = Regex(
            "(?i)\\b(class|public|private|protected|static|void|return|function|def|import|const|let|var|new|if|else|for|while)\\b"
        ).containsMatchIn(text)
        // dense punctuation + at least one keyword OR very dense punctuation alone
        return (punctCount >= 3 && hasKeyword) || punctCount >= 6
    }

    /**
     * Detect a fenced-code-block language tag from the text. Returns
     * empty string if uncertain (mobile renderer falls back to a
     * generic code block in that case).
     */
    private fun detectCodeLang(text: String): String {
        val t = text
        return when {
            Regex("\\bpublic\\s+(?:static\\s+)?(?:void|class|final|abstract)\\b").containsMatchIn(t) -> "java"
            Regex("\\bSystem\\.out\\.println\\b").containsMatchIn(t) -> "java"
            Regex("\\bdef\\s+\\w+\\s*\\(").containsMatchIn(t) -> "python"
            Regex("\\bprint\\(").containsMatchIn(t) && Regex("\\bimport\\s+\\w").containsMatchIn(t) -> "python"
            Regex("\\b(?:const|let|var)\\s+\\w+\\s*=").containsMatchIn(t) -> "javascript"
            Regex("\\bfunction\\s+\\w+\\s*\\(").containsMatchIn(t) -> "javascript"
            Regex("\\bfn\\s+\\w+\\s*\\(").containsMatchIn(t) -> "rust"
            Regex("\\bfunc\\s+\\w+\\s*\\(").containsMatchIn(t) -> "go"
            Regex("#include\\s*<").containsMatchIn(t) -> "cpp"
            Regex("<\\w+[^>]*>").containsMatchIn(t) && Regex("</\\w+>").containsMatchIn(t) -> "html"
            else -> ""
        }
    }

    /**
     * Attempt to reflow a single-line flattened code string into
     * multiple lines by inserting newlines after `;`, `{`, and before
     * `}`. The accessibility tree gives us all-on-one-line code; we
     * can't recover the original indentation, but introducing line
     * breaks at statement / block boundaries makes the mobile rendering
     * massively more readable than a 600-char wall of text.
     *
     * Conservative: only reflows when the input is clearly a single
     * line (no embedded `\n`) and is long (>60 chars). Otherwise
     * returns the input unchanged.
     */
    private fun reflowCodeLine(s: String): String {
        if (s.contains('\n') || s.length < 60) return s
        val out = StringBuilder()
        var i = 0
        var inString = false
        var stringChar = '"'
        while (i < s.length) {
            val c = s[i]
            out.append(c)
            if (inString) {
                if (c == '\\' && i + 1 < s.length) { out.append(s[i + 1]); i += 2; continue }
                if (c == stringChar) inString = false
            } else {
                if (c == '"' || c == '\'') { inString = true; stringChar = c }
                else if (c == '{' || c == ';') {
                    // newline after structural punctuation, swallowing
                    // any following space
                    var j = i + 1
                    while (j < s.length && s[j] == ' ') j++
                    if (j < s.length && s[j] != '\n') out.append('\n')
                    i = j
                    continue
                } else if (c == '}') {
                    // newline AFTER `}` too
                    var j = i + 1
                    while (j < s.length && s[j] == ' ') j++
                    if (j < s.length && s[j] != '\n') out.append('\n')
                    i = j
                    continue
                }
            }
            i++
        }
        return out.toString()
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
