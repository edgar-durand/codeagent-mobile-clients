package com.windsurf.controller.services

/**
 * Port of `detectSelector` / `detectListSelector` from
 * `packages/shared/src/protocol/parseChrome.ts` to Kotlin — detects
 * Claude Code's interactive selectors in the rendered terminal
 * output so the JetBrains plugin can ship `select_prompt` chunks to
 * the mobile / web clients.
 *
 * The TypeScript file is the source of truth; this Kotlin port
 * mirrors it line-for-line. If you change either side, change both.
 * (The shared-package note in the repo's CLAUDE.md explicitly
 * authorizes deliberate Kotlin ports here.)
 */
data class SelectPrompt(
    val question: String,
    val options: List<String>,
    val optionDescriptions: List<String>,
    /** 0-based index of the highlighted item (always 0 for numbered selectors). */
    val currentIndex: Int,
)

/**
 * Stable string fingerprint used by the polling loop to dedup
 * `select_prompt` emissions while the selector stays on screen.
 * Identical question + options + currentIndex → identical signature.
 */
fun SelectPrompt.signature(): String =
    "$question|${options.joinToString("")}|$currentIndex"

object SelectorDetector {

    private val SHORTCUT_HINT = Regex("\\?\\s+for\\s+shortcuts", RegexOption.IGNORE_CASE)
    private val LEFT_BORDER = Regex("^[│╭╰╮╯┌└┐┘├┤┬┴┼]\\s?")
    private val RIGHT_BORDER = Regex("\\s*[│╭╰╮╯┌└┐┘├┤┬┴┼─━═]+\\s*$")
    private val DASH_LINE = Regex("^[─━—═\\-]{3,}$")
    private val BRACKET_LINE = Regex("^\\[.*]$")
    private val CURSOR_PREFIX = Regex("^[>❯]\\s")
    private val NUMBERED_OPTION = Regex("^(?:[❯>]\\s*)?(\\d+)\\.\\s+(.+)")
    private val NUMBERED_LINE = Regex("^(?:[❯>]\\s*)?\\d+\\.\\s")
    private val CURSOR_NUMBERED = Regex("^[❯>]\\s*\\d+\\.")
    private val TRUST_DIALOG = Regex(
        "\\b(?:trust\\s+the\\s+files|trust\\s+this\\s+folder|safety\\s+check)\\b",
        RegexOption.IGNORE_CASE,
    )
    private val NAV_HINT = Regex("[↑↓].*navigate", RegexOption.IGNORE_CASE)
    private val ENTER_TO = Regex("^Enter to", RegexOption.IGNORE_CASE)
    private val ESC_TO = Regex("Esc to", RegexOption.IGNORE_CASE)
    private val LIST_SELECTED = Regex("^\\s+❯\\s+\\S")
    private val LIST_UNSELECTED = Regex("^ {4}\\S")

    /**
     * Detect a numbered interactive selector — `❯ 1. Label` style — in
     * already-rendered screen lines. Anchors on the cursor presence
     * OR a trust-dialog signature so a render that ate the `❯` (e.g.
     * Windows ConPTY font fallback) still surfaces the selector.
     */
    fun detectSelector(lines: List<String>): SelectPrompt? {
        if (lines.any { SHORTCUT_HINT.containsMatchIn(it.trim()) }) return null

        // Strip box-border chars from line edges so numbered selectors
        // rendered inside a bordered panel (e.g. /mcp detail view) are
        // still detected.
        val clean = lines.map {
            it.replace(LEFT_BORDER, "").replace(RIGHT_BORDER, "")
        }

        val hasCursor = clean.any { CURSOR_NUMBERED.containsMatchIn(it.trim()) }
        val looksLikeTrust = clean.any { TRUST_DIALOG.containsMatchIn(it) }
        if (!hasCursor && !looksLikeTrust) return null

        var optionStartIdx = -1
        for (i in clean.indices) {
            if (NUMBERED_LINE.containsMatchIn(clean[i].trim())) {
                optionStartIdx = i
                break
            }
        }
        if (optionStartIdx == -1) return null

        val questionParts = mutableListOf<String>()
        for (i in 0 until optionStartIdx) {
            val t = clean[i].trim()
            if (t.isEmpty()) continue
            if (DASH_LINE.matches(t)) continue
            if (BRACKET_LINE.matches(t)) continue
            if (CURSOR_PREFIX.containsMatchIn(t)) continue
            // PTY overwrite artifact — no spaces + long.
            if (!t.contains(' ') && t.length > 15) continue
            questionParts.add(t)
        }
        val dedupedQuestion = questionParts
            .filterIndexed { i, line ->
                questionParts.withIndex().none { (j, other) -> j != i && other.contains(line) }
            }
            .joinToString("\n")
            .trim()

        val optionLabels = linkedMapOf<Int, String>()
        val optionDescs = mutableMapOf<Int, MutableList<String>>()
        var currentNum = -1

        for (i in optionStartIdx until clean.size) {
            val t = clean[i].trim()
            if (t.isEmpty()) continue

            val m = NUMBERED_OPTION.find(t)
            if (m != null) {
                val num = m.groupValues[1].toInt()
                if (!optionLabels.containsKey(num)) {
                    optionLabels[num] = m.groupValues[2].trim()
                    optionDescs[num] = mutableListOf()
                }
                currentNum = num
            } else if (
                currentNum != -1 &&
                !ENTER_TO.containsMatchIn(t) &&
                !DASH_LINE.matches(t) &&
                !NAV_HINT.containsMatchIn(t) &&
                !ESC_TO.containsMatchIn(t)
            ) {
                optionDescs[currentNum]?.add(t)
            }
        }

        val keys = optionLabels.keys.sorted()
        if (keys.size < 2 || keys.first() != 1) return null

        return SelectPrompt(
            question = dedupedQuestion,
            options = keys.map { optionLabels[it]!! },
            optionDescriptions = keys.map { (optionDescs[it] ?: emptyList()).joinToString(" ").trim() },
            currentIndex = 0,
        )
    }

    /**
     * Detect a list-style selector — `/mcp`, `/model` — where the
     * highlighted item is prefixed with `  ❯ ` instead of `❯ N.`.
     * Returns `currentIndex` so the client can send bidirectional
     * arrow navigation rather than always starting from 0.
     */
    fun detectListSelector(lines: List<String>): SelectPrompt? {
        if (lines.none { NAV_HINT.containsMatchIn(it.trim()) }) return null
        if (lines.any { Regex("^❯\\s*\\d+\\.").containsMatchIn(it.trim()) }) return null
        if (lines.none { LIST_SELECTED.containsMatchIn(it) }) return null

        fun isSelected(line: String): Boolean = LIST_SELECTED.containsMatchIn(line)
        fun isUnselected(line: String): Boolean = LIST_UNSELECTED.containsMatchIn(line)
        fun isItem(line: String): Boolean = isSelected(line) || isUnselected(line)

        var optionStartIdx = -1
        for (i in lines.indices) {
            if (isItem(lines[i])) {
                optionStartIdx = i
                break
            }
        }
        if (optionStartIdx == -1) return null

        val questionParts = mutableListOf<String>()
        for (i in 0 until optionStartIdx) {
            val t = lines[i].trim()
            if (t.isEmpty()) continue
            if (DASH_LINE.matches(t)) continue
            if (Regex("[┌└│┐┘├┤┬┴┼]").containsMatchIn(t)) {
                val inner = t.replace(Regex("[│┌└┐┘├┤┬┴┼─]"), "").trim()
                if (inner.isNotEmpty()) questionParts.add(inner)
                continue
            }
            if (CURSOR_PREFIX.containsMatchIn(t)) continue
            if (NAV_HINT.containsMatchIn(t)) continue
            if (!t.contains(' ') && t.length > 15) continue
            questionParts.add(t)
        }
        val dedupedQuestion = questionParts
            .filterIndexed { i, line ->
                questionParts.withIndex().none { (j, other) -> j != i && other.contains(line) }
            }
            .joinToString("\n")
            .trim()

        val options = mutableListOf<String>()
        var currentIndex = 0

        for (line in lines.subList(optionStartIdx, lines.size)) {
            val t = line.trim()
            if (t.isEmpty()) continue
            if (NAV_HINT.containsMatchIn(t)) break
            if (DASH_LINE.matches(t)) continue

            if (isSelected(line)) {
                currentIndex = options.size
                options.add(t.replace(Regex("^❯\\s+"), "").trim())
            } else if (isUnselected(line)) {
                options.add(t)
            }
        }

        if (options.size < 2) return null

        return SelectPrompt(
            question = dedupedQuestion,
            options = options,
            optionDescriptions = options.map { "" },
            currentIndex = currentIndex,
        )
    }
}
