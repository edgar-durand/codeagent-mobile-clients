package com.windsurf.controller.ui

/**
 * Canonical user-facing strings for the JetBrains plugin. Locks the
 * notification voice to `CodeAgent Mobile · <message>.` — middle-dot
 * separator + period — so the brand name doesn't drift across files
 * and so we never leak implementation details ("workbench
 * modification", dev-log arrows) into the notification surface.
 *
 * Mirror of `apps/vsc-plugin/src/ui/messages.ts`. When you add an
 * entry there, mirror it here.
 */
object BrandMessages {
    private const val BRAND = "CodeAgent Mobile"
    private fun notification(body: String): String = "$BRAND · $body"

    val Disconnected: String = notification("Disconnected.")
    fun connectedTo(email: String): String = notification("Connected as $email.")
    val SessionExpired: String = notification("Session expired. Re-pair to continue.")

    /**
     * Promotes the "(no project)", "(no AI agent found)", "(delivery
     * failed)" tail into a single tone-consistent line. The reason
     * is appended so the user still sees why the fallback fired,
     * but it's framed as the reason for the clipboard fallback —
     * not as a parenthetical bug code.
     */
    fun promptCopiedToClipboard(reason: String? = null): String {
        val tail = if (reason.isNullOrBlank()) {
            "Prompt copied to clipboard — paste it into the chat and press Enter."
        } else {
            "Prompt copied to clipboard — $reason. Paste it into the chat and press Enter."
        }
        return notification(tail)
    }

    const val EmptyAgentList: String =
        "No agents detected yet. Install Claude Code or sign in to AI Assistant, then refresh."
    const val EmptyRecentSessions: String =
        "No recent sessions yet. Generate a pairing code to start."
}
