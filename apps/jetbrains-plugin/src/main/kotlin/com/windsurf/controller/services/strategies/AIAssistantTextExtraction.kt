package com.windsurf.controller.services.strategies

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.ex.EditorEx
import com.intellij.openapi.editor.impl.EditorImpl
import com.intellij.openapi.editor.markup.HighlighterTargetArea
import com.intellij.openapi.editor.markup.RangeHighlighter
import java.awt.Component
import java.awt.Container
import javax.accessibility.AccessibleContext
import javax.accessibility.AccessibleText
import javax.swing.JEditorPane
import javax.swing.JLabel
import javax.swing.JTextArea
import javax.swing.JTextField
import javax.swing.text.JTextComponent

/**
 * Stateless text-extraction helpers used by
 * AIAssistantMessageExtractor's `collectMessageParts` path. They walk
 * the IDE's accessibility tree and Y-coordinate-sort the visible
 * Swing components to reconstruct the rendered bubble.
 *
 * No instance state — every method takes the root Component / text /
 * Document it operates on. Logger is the file-local singleton.
 *
 * Extracted from AIAssistantMessageExtractor (was 816 LOC) so the
 * extractor can stay focused on the MessagePart shape + the
 * `collectMessageParts` orchestration. None of these methods
 * reference the extractor's instance state — they only read
 * geometry / accessibility / text content from the components they
 * walk.
 */
internal object AIAssistantTextExtraction {

    private val logger = Logger.getInstance(AIAssistantTextExtraction::class.java)

    /** Recursively visit every Component under `root`. */
    fun walkSwing(root: java.awt.Component, visit: (java.awt.Component) -> Unit) {
        visit(root)
        if (root is java.awt.Container) {
            for (i in 0 until root.componentCount) walkSwing(root.getComponent(i), visit)
        }
    }

    /** Absolute Y coordinate of `c` inside `root`'s coordinate space. */
    fun absoluteY(c: java.awt.Component, root: java.awt.Component): Int {
        return try {
            val p = javax.swing.SwingUtilities.convertPoint(c, java.awt.Point(0, 0), root)
            p.y
        } catch (_: Exception) {
            0
        }
    }

    /** Loading / thinking strings the AI Assistant emits during streaming. */
    val CHROME_LABELS: Set<String> = setOf(
        "thinking…", "thinking...", "generating…", "generating...",
        "stop", "stop generating", "loading…", "loading...",
    )

    /** Leaf node captured by accessibility-tree scrape — held in
     *  Y / X coordinate space so tryReconstructTableByY can cluster
     *  rows + columns from the visual layout. */
    data class GridLeaf(val text: String, val y: Int, val x: Int)

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
fun collectAccessibleStrings(root: Component): String {
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
fun tryReconstructTableByY(root: Component, whitespace: Regex): String? {
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
fun looksLikeDiff(text: String): Boolean {
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
fun looksLikeCode(text: String): Boolean {
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
fun detectCodeLang(text: String): String {
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
fun reflowCodeLine(s: String): String {
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
}
