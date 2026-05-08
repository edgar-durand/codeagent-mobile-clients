package com.windsurf.controller.services

/**
 * Port of `packages/shared/src/protocol/parseChrome.ts` to Kotlin —
 * detects Claude Code's TUI chrome lines (spinners, bullets, tree
 * connectors, status lines) and converts them into `ChromeStep`s
 * the mobile / web clients render as the "thinking…" timeline above
 * the agent's textual response.
 *
 * If you change either side, change both. (CLAUDE.md authorizes
 * deliberate ports here for the JetBrains plugin.)
 */
data class ChromeStep(
    /** "read" | "edit" | "bash" | "search" | "thinking" | "other" */
    val tool: String,
    val label: String,
    val detail: String? = null,
    /** "running" | "done" */
    val status: String = "running",
)

object ChromeParser {

    private val SPINNER_RE = Regex(
        "^(?:[✳✢✶✻✽✴✷✸✹⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◑◒◓▁▂▃▄▅▆▇█]|🔴|🟠|🟡|🟢|🔵|🟣|🟤|⚫|⚪|🌀|💭|✨)\\s",
    )

    private val BULLET_TOOL_RE = Regex(
        "^•\\s+(?:Read(?:ing)?|Edit(?:ing)?|Writ(?:e|ing)|Bash|Runn(?:ing)?|Search(?:ing)?|Glob(?:bing)?|Grep(?:ping)?|Creat(?:e|ing)|Execut(?:e|ing)|Task|Agent|NotebookEdit)\\b",
        RegexOption.IGNORE_CASE,
    )
    private val TREE_LINE_RE = Regex("^└\\s")
    private val STATUS_LINE_RE = Regex(
        "^(?:\\+|[🔴🟠🟡🟢🔵🟣🟤⚫⚪🌀💭✨])\\s",
    )

    private val DASH_LINE = Regex("^[─━—═\\-]{3,}$")
    private val LONE_CURSOR = Regex("^[❯>]\\s*$")
    private val THINKING_PARENS = Regex("^\\(thinking\\)\\s*$")
    private val ESC_INTERRUPT = Regex("esc.{0,5}to.{0,5}interrupt", RegexOption.IGNORE_CASE)
    private val HIGH_EFFORT = Regex("high\\s*[·•]\\s*/effort", RegexOption.IGNORE_CASE)
    private val NAVIGATE = Regex("↑\\s*/?\\s*↓\\s*to\\s*navigate", RegexOption.IGNORE_CASE)
    private val EXPAND = Regex("ctrl\\+?o\\s+to\\s+expand", RegexOption.IGNORE_CASE)
    private val SPENDING = Regex("spending limit|usage limit", RegexOption.IGNORE_CASE)
    private val SHORTCUT = Regex("^\\?\\s.*shortcut", RegexOption.IGNORE_CASE)
    private val DOWN_TOKENS = Regex("^↓\\s*\\d+\\s*tokens", RegexOption.IGNORE_CASE)
    private val THOUGHT_FOR = Regex("^\\bthought\\s+for\\s+\\d+", RegexOption.IGNORE_CASE)
    private val STATUS_DETAIL = Regex(
        "\\d+\\s*s\\s*[·•]|\\bthought\\s+for\\b|\\d+\\s*tokens|\\(thinking\\)",
        RegexOption.IGNORE_CASE,
    )

    private val VARIATION_SELECTOR = Regex("️")

    /**
     * Tells whether a line is TUI chrome that should be filtered from
     * the conversation text and routed through `chrome_steps` instead.
     */
    fun isChromeLine(line: String): Boolean {
        val t = line.replace(VARIATION_SELECTOR, "").trim()
        if (t.isEmpty()) return false
        if (DASH_LINE.matches(t)) return true
        if (SPINNER_RE.containsMatchIn(t)) return true
        if (BULLET_TOOL_RE.containsMatchIn(t)) return true
        if (TREE_LINE_RE.containsMatchIn(t)) return true
        if (STATUS_LINE_RE.containsMatchIn(t) && STATUS_DETAIL.containsMatchIn(t)) return true
        if (DOWN_TOKENS.containsMatchIn(t)) return true
        if (THOUGHT_FOR.containsMatchIn(t)) return true
        if (ESC_INTERRUPT.containsMatchIn(t)) return true
        if (HIGH_EFFORT.containsMatchIn(t)) return true
        if (LONE_CURSOR.matches(t)) return true
        if (THINKING_PARENS.matches(t)) return true
        if (SHORTCUT.containsMatchIn(t)) return true
        if (SPENDING.containsMatchIn(t) && t.length < 80) return true
        if (NAVIGATE.containsMatchIn(t)) return true
        if (t.replace(Regex("\\s"), "").length == 1) return true
        if ((Regex("─").findAll(t).count()) >= 6) return true
        if (EXPAND.containsMatchIn(t)) return true
        val hasBoxPrefix = Regex("^[│╭╰╮╯┌└┐┘├┤┬┴┼]").containsMatchIn(t)
        val stripped = t.replace(Regex("^[│╭╰╮╯┌└┐┘├┤┬┴┼]\\s?"), "")
        if (hasBoxPrefix &&
            Regex("^[❯>]\\s+\\S").containsMatchIn(stripped) &&
            !Regex("^[❯>]\\s*\\d+\\.").containsMatchIn(stripped)
        ) return true
        return false
    }

    /** Convert a single chrome line to a typed step, or null to drop. */
    fun parseChromeLine(line: String): ChromeStep? {
        val t = line.replace(VARIATION_SELECTOR, "").trim()
        if (t.isEmpty()) return null

        if (DASH_LINE.matches(t)) return null
        if (LONE_CURSOR.matches(t)) return null
        if (t.replace(Regex("\\s"), "").length == 1) return null
        if ((Regex("─").findAll(t).count()) >= 6) return null

        if (ESC_INTERRUPT.containsMatchIn(t)) return null
        if (HIGH_EFFORT.containsMatchIn(t)) return null
        if (NAVIGATE.containsMatchIn(t)) return null
        if (EXPAND.containsMatchIn(t)) return null
        if (SPENDING.containsMatchIn(t)) return null

        if (THINKING_PARENS.matches(t)) {
            return ChromeStep(tool = "thinking", label = "Thinking…", status = "running")
        }

        if (TREE_LINE_RE.containsMatchIn(t)) return null

        // Status/thinking line: "+ Puttering… (22s · ↑ 102 tokens)".
        // Only the verb before "…" is the stable identifier.
        if (STATUS_LINE_RE.containsMatchIn(t)) {
            val rawLabel = t.drop(2).replace(Regex("….*", RegexOption.DOT_MATCHES_ALL), "").trim()
            val label = if (rawLabel.isNotEmpty()) rawLabel else "Thinking…"
            return ChromeStep(tool = "thinking", label = label, status = "running")
        }

        var text = t
        if (SPINNER_RE.containsMatchIn(t)) {
            text = t.drop(2).trim()
                .replace(Regex("….*", RegexOption.DOT_MATCHES_ALL), "")
                .trim()
        } else if (BULLET_TOOL_RE.containsMatchIn(t)) {
            text = t.drop(2).trim()
                .replace(Regex("\\s*\\(ctrl\\+?o[^)]*\\)", RegexOption.IGNORE_CASE), "")
                .replace(Regex(",\\s*reading\\s+\\d+\\s+files?\\s*…?", RegexOption.IGNORE_CASE), "")
                .replace(Regex(",\\s*\\d+\\s+files?\\s*…?", RegexOption.IGNORE_CASE), "")
                .replace(Regex("…$"), "")
                .trim()
        }

        if (text.isEmpty()) return null

        return classifyStep(text)
    }

    private fun classifyStep(text: String): ChromeStep {
        if (Regex("^Read(?:ing)?\\s+", RegexOption.IGNORE_CASE).containsMatchIn(text)) {
            val label = text
                .replace(Regex("^Read(?:ing)?\\s+", RegexOption.IGNORE_CASE), "")
                .replace(Regex("\\.\\.\\.$"), "")
                .trim()
            return ChromeStep(tool = "read", label = label, status = "running")
        }
        if (Regex(
                "^Edit(?:ing)?\\s+|^Writ(?:e|ing|ing to)\\s+|^Creat(?:e|ing)\\s+",
                RegexOption.IGNORE_CASE,
            ).containsMatchIn(text)) {
            val label = text
                .replace(
                    Regex(
                        "^(?:Edit(?:ing)?|Writ(?:e|ing(?: to)?)|Creat(?:e|ing))\\s+",
                        RegexOption.IGNORE_CASE,
                    ),
                    "",
                )
                .replace(Regex("\\.\\.\\.$"), "")
                .trim()
            return ChromeStep(tool = "edit", label = label, status = "running")
        }
        if (Regex(
                "^Runn(?:ing)?\\s+|^Execut(?:e|ing)\\s+|^Bash(?:ing)?\\s*:|^\\$\\s+",
                RegexOption.IGNORE_CASE,
            ).containsMatchIn(text)) {
            val label = text
                .replace(
                    Regex(
                        "^(?:Runn(?:ing)?|Execut(?:e|ing)|Bash(?:ing)?:|\\$)\\s+",
                        RegexOption.IGNORE_CASE,
                    ),
                    "",
                )
                .replace(Regex("\\.\\.\\.$"), "")
                .trim()
            return ChromeStep(tool = "bash", label = label, status = "running")
        }
        if (Regex("^Search(?:ing)?\\s+for\\s+|^Grep(?:ping)?\\s*:", RegexOption.IGNORE_CASE)
                .containsMatchIn(text)) {
            val label = text
                .replace(
                    Regex("^(?:Search(?:ing)?\\s+for|Grep(?:ping)?:)\\s+", RegexOption.IGNORE_CASE),
                    "",
                )
                .replace(Regex("\\.\\.\\.$"), "")
                .trim()
            return ChromeStep(tool = "search", label = label, status = "running")
        }
        val label = text.replace(Regex("\\.\\.\\.$"), "").trim()
        return ChromeStep(tool = "other", label = label, status = "running")
    }
}

/** Stable string identity used for `chrome_steps` delta dedup. */
fun ChromeStep.signature(): String = "$tool|$label"
