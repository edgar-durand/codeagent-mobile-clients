package com.windsurf.controller.services

/**
 * Catalog of agents the plugin marks as "terminal" so the mobile
 * knows to dispatch their runtime commands to codeam-cli's pluginId
 * rather than to this plugin. The plugin itself does NOT run any
 * terminal agent — Claude / Codex / Cursor / CodeRabbit / Aider all
 * live in the CLI.
 *
 * Only metadata lives here (id, name, icon, pluginId). No PTY
 * lifecycle, no parser, no polling loop — those used to live in a
 * `TerminalAgentService` that has been removed.
 */
data class TerminalAgentConfig(
    val id: String,
    val name: String,
    val icon: String,
    val pluginId: String,
)

object TerminalAgentCatalog {
    val TERMINAL_AGENTS: List<TerminalAgentConfig> = listOf(
        TerminalAgentConfig(
            id = "claude_code",
            name = "Claude Code",
            icon = "claude",
            pluginId = "com.anthropic.claudecode",
        ),
    )
}
