package com.windsurf.controller.services.strategies

import javax.swing.text.Element
import javax.swing.text.JTextComponent
import javax.swing.text.html.HTML
import javax.swing.text.html.HTMLDocument

/**
 * Convert the live `HTMLDocument` of a JTextPane / JEditorPane to
 * GitHub-flavored markdown. Used by every extractor whose agent
 * renders message parts via Swing's HTMLEditorKit (Copilot's
 * `MarkdownPane`, AI Assistant's `TextPartViewEditorPane`, …).
 *
 * Why walk the document tree instead of parsing `getText()`:
 *
 *   • Swing's HTML parser decodes named and numeric entities at parse
 *     time (`&#x27;`, `&amp;`, `&#55357;&#56395;` → `'`, `&`, `👋`),
 *     so the strings we read are already the original characters.
 *   • Block/inline structure comes from `Element.getName()`,
 *     attributes from `AttributeSet`. Adding a new tag means a single
 *     `when` branch — no regex layered on top of regex.
 */
object HtmlPaneToMarkdown {

    /** Top-level entry. Returns trimmed markdown for the whole document. */
    fun convert(pane: JTextComponent): String {
        val doc = pane.document
        if (doc !is HTMLDocument) return pane.text?.trim() ?: ""
        val sb = StringBuilder()
        walkBlock(doc, doc.defaultRootElement, sb)
        return sb.toString()
            .replace(Regex("[ \\t]+\n"), "\n")
            .replace(Regex("\n{3,}"), "\n\n")
            .trim()
    }

    private fun elementTag(el: Element): String = el.name?.lowercase() ?: ""

    private fun walkBlock(doc: HTMLDocument, el: Element, sb: StringBuilder) {
        when (elementTag(el)) {
            "pre" -> emitPre(doc, el, sb)
            "ul" -> emitList(doc, el, sb, ordered = false)
            "ol" -> emitList(doc, el, sb, ordered = true)
            "table" -> emitTable(doc, el, sb)
            "blockquote" -> emitBlockquote(doc, el, sb)
            "h1", "h2", "h3", "h4", "h5", "h6" -> emitHeading(doc, el, sb)
            "hr" -> sb.append("\n---\n\n")
            "p" -> { walkInlineChildren(doc, el, sb); sb.append("\n\n") }
            "head", "title", "style", "script" -> { /* skip metadata */ }
            else -> {
                if (el.isLeaf) {
                    sb.append(safeText(doc, el))
                } else {
                    for (i in 0 until el.elementCount) walkBlock(doc, el.getElement(i), sb)
                }
            }
        }
    }

    private fun walkInlineChildren(doc: HTMLDocument, el: Element, sb: StringBuilder) {
        for (i in 0 until el.elementCount) walkInline(doc, el.getElement(i), sb)
    }

    private fun walkInline(doc: HTMLDocument, el: Element, sb: StringBuilder) {
        if (el.isLeaf) {
            sb.append(safeText(doc, el))
            return
        }
        when (elementTag(el)) {
            "code" -> sb.append("`").append(safeText(doc, el)).append("`")
            "b", "strong" -> { sb.append("**"); walkInlineChildren(doc, el, sb); sb.append("**") }
            "i", "em" -> { sb.append("*"); walkInlineChildren(doc, el, sb); sb.append("*") }
            "a" -> {
                val href = el.attributes.getAttribute(HTML.Attribute.HREF)?.toString().orEmpty()
                sb.append("[")
                walkInlineChildren(doc, el, sb)
                sb.append("](").append(href).append(")")
            }
            "br" -> sb.append("\n")
            "img" -> {
                val alt = el.attributes.getAttribute(HTML.Attribute.ALT)?.toString().orEmpty()
                val src = el.attributes.getAttribute(HTML.Attribute.SRC)?.toString().orEmpty()
                sb.append("![").append(alt).append("](").append(src).append(")")
            }
            "pre", "ul", "ol", "table", "blockquote", "p",
            "h1", "h2", "h3", "h4", "h5", "h6" -> walkBlock(doc, el, sb)
            else -> walkInlineChildren(doc, el, sb)
        }
    }

    private fun emitPre(doc: HTMLDocument, pre: Element, sb: StringBuilder) {
        val lang = inferLanguage(pre)
        val code = safeText(doc, pre).trimEnd('\n')
        if (code.isBlank()) return
        sb.append("\n```").append(lang).append("\n").append(code).append("\n```\n\n")
    }

    private fun inferLanguage(pre: Element): String {
        val regex = Regex("lang(?:uage)?-([\\w+#.-]+)")
        val classOnPre = pre.attributes.getAttribute(HTML.Attribute.CLASS)?.toString().orEmpty()
        regex.find(classOnPre)?.let { return it.groupValues[1] }
        for (i in 0 until pre.elementCount) {
            val child = pre.getElement(i)
            if (elementTag(child) == "code") {
                val cls = child.attributes.getAttribute(HTML.Attribute.CLASS)?.toString().orEmpty()
                regex.find(cls)?.let { return it.groupValues[1] }
            }
        }
        return ""
    }

    private fun emitList(doc: HTMLDocument, list: Element, sb: StringBuilder, ordered: Boolean) {
        sb.append("\n")
        var idx = 1
        for (i in 0 until list.elementCount) {
            val li = list.getElement(i)
            if (elementTag(li) != "li") continue
            sb.append(if (ordered) "${idx++}. " else "- ")
            walkInlineChildren(doc, li, sb)
            while (sb.isNotEmpty() && sb.last() == '\n') sb.deleteCharAt(sb.length - 1)
            sb.append("\n")
        }
        sb.append("\n")
    }

    private fun emitHeading(doc: HTMLDocument, h: Element, sb: StringBuilder) {
        val level = elementTag(h).last().digitToIntOrNull() ?: 1
        sb.append("\n").append("#".repeat(level)).append(" ")
        walkInlineChildren(doc, h, sb)
        sb.append("\n\n")
    }

    private fun emitBlockquote(doc: HTMLDocument, bq: Element, sb: StringBuilder) {
        val inner = StringBuilder()
        for (i in 0 until bq.elementCount) walkBlock(doc, bq.getElement(i), inner)
        val text = inner.toString().trim()
        if (text.isBlank()) return
        text.split("\n").forEach { sb.append("> ").append(it).append("\n") }
        sb.append("\n")
    }

    private fun emitTable(doc: HTMLDocument, table: Element, sb: StringBuilder) {
        val rows = mutableListOf<List<String>>()
        fun collectRows(container: Element) {
            for (i in 0 until container.elementCount) {
                val child = container.getElement(i)
                when (elementTag(child)) {
                    "tr" -> {
                        val cells = mutableListOf<String>()
                        for (j in 0 until child.elementCount) {
                            val cell = child.getElement(j)
                            val tag = elementTag(cell)
                            if (tag == "td" || tag == "th") {
                                cells += safeText(doc, cell)
                                    .replace("|", "\\|")
                                    .replace(Regex("\\s+"), " ")
                                    .trim()
                            }
                        }
                        if (cells.isNotEmpty()) rows += cells
                    }
                    "thead", "tbody", "tfoot" -> collectRows(child)
                }
            }
        }
        collectRows(table)
        if (rows.isEmpty()) return
        val cols = rows.maxOf { it.size }
        sb.append("\n")
        val header = rows[0] + List(maxOf(0, cols - rows[0].size)) { "" }
        sb.append("| ").append(header.take(cols).joinToString(" | ")).append(" |\n")
        sb.append("|").append((0 until cols).joinToString("|") { " --- " }).append("|\n")
        for (i in 1 until rows.size) {
            val padded = rows[i] + List(maxOf(0, cols - rows[i].size)) { "" }
            sb.append("| ").append(padded.take(cols).joinToString(" | ")).append(" |\n")
        }
        sb.append("\n")
    }

    private fun safeText(doc: HTMLDocument, el: Element): String =
        try { doc.getText(el.startOffset, el.endOffset - el.startOffset) }
        catch (_: Exception) { "" }
}
