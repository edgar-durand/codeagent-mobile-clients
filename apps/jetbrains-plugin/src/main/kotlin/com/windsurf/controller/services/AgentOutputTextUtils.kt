package com.windsurf.controller.services

/**
 * Pure-function text + HTML cleanup helpers used by AgentOutputMonitor's
 * scrape paths. Extracted into a top-level object so the helpers can be
 * unit-tested without instantiating the whole monitor (which pulls in
 * IntelliJ Platform fixtures).
 */
internal object AgentOutputTextUtils {

    /**
     * Strip class/style/data-* attributes off the captured HTML. The
     * captured chrome from Cascade / Copilot / AI Assistant carries a
     * lot of Tailwind utility classes (`class="px-2 py-1 ..."`) that
     * the mobile renderer never reads — we drop them to keep the
     * relay payload small and the markdown clean.
     */
    fun stripTailwindClasses(html: String): String {
        return html
            .replace(Regex("""\s+class="[^"]*""""), "")
            .replace(Regex("""\s+class='[^']*'"""), "")
            .replace(Regex("""\s+style="[^"]*""""), "")
            .replace(Regex("""\s+data-[a-z-]+="[^"]*""""), "")
    }

    /**
     * Squash whitespace + drop the JCEF/Swing drag-drop affordance
     * strings ("Drop to add to chat") that leak into the snapshot
     * when the IDE has them mounted but invisible.
     */
    fun cleanCapturedText(text: String): String {
        return text
            .replace(Regex("Drop to add to \\w+"), "")
            .replace(Regex("(?m)^\\s*Drop to add.*$"), "")
            .replace(Regex("\n{3,}"), "\n\n")
            .trim()
    }

    /**
     * Markdown-ish text extraction from captured HTML. Preserves
     * paragraph + list + heading structure (newlines on closing
     * tags) and decodes the entities Cascade / Copilot consistently
     * emit. Not a full HTML→Markdown converter — the mobile renderer
     * does the final markdown parsing.
     */
    fun stripHtml(html: String): String {
        var text = html
        text = text.replace(Regex("(?is)<script[^>]*>.*?</script>"), " ")
        text = text.replace(Regex("(?is)<style[^>]*>.*?</style>"), " ")
        text = text.replace(Regex("(?is)<noscript[^>]*>.*?</noscript>"), " ")
        text = text.replace(Regex("<br\\s*/?>", RegexOption.IGNORE_CASE), "\n")
        text = text.replace(Regex("</(?:p|div|h[1-6]|li|tr)>", RegexOption.IGNORE_CASE), "\n")
        text = text.replace(Regex("<[^>]+>"), " ")
        text = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
            .replace("&quot;", "\"").replace("&#39;", "'").replace("&nbsp;", " ")
        text = text.replace(Regex("[ \\t]+"), " ")
        text = text.replace(Regex("\\n{3,}"), "\n\n")
        return text.trim()
    }
}
