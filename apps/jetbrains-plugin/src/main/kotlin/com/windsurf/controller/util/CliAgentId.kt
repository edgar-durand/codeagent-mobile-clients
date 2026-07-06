package com.windsurf.controller.util

/**
 * Normalize an agent id coming from mobile/web into a codeam-cli
 * agent id, or `null` when the value is unknown/disabled.
 *
 * ⚠️ Deliberate port of the VS Code extension's registry-driven
 * normalizer — keep the two in sync on every change:
 *   apps/vsc-plugin/src/utils/cli-agent-id.ts
 * (which reads AGENT_REGISTRY / isKnownAgentId from
 *  packages/shared/src/agents/registry.ts — the JetBrains plugin is
 *  Kotlin and can't consume the shared package, so the enabled-agent
 *  set and alias table are mirrored here by hand.)
 *
 * The returned id is always one of the fixed whitelist below, so it
 * is safe to splice into a terminal command line (`codeam pair
 * --agent=<id>` / `codeam link <id>`) without further sanitisation.
 */
object CliAgentId {

    /** AGENT_REGISTRY entries with `enabled: true` (copilot is disabled). */
    private val ENABLED_AGENT_IDS = setOf(
        "claude",
        "codex",
        "coderabbit",
        "cursor",
        "aider",
        "gemini",
    )

    /** Mirrors CLI_AGENT_ALIASES in cli-agent-id.ts. */
    private val CLI_AGENT_ALIASES = mapOf(
        "claude_code" to "claude",
        "claude-code" to "claude",
        "anthropic.claude-code" to "claude",
        "anthropics.claude" to "claude",
        "anthropic.claude-ce" to "claude",
        "anthropic.claude" to "claude",
        "com.anthropic.claudecode" to "claude",
        "com.anthropic.claude" to "claude",
        "openai.chatgpt" to "codex",
        "coderabbitai.coderabbit-vscode" to "coderabbit",
    )

    private const val TERMINAL_PREFIX = "__terminal__:"

    fun normalizeCliAgentId(raw: String?): String? {
        val value = raw?.trim()?.lowercase() ?: return null
        if (value.isEmpty()) return null

        if (value in ENABLED_AGENT_IDS) return value

        val unprefixed = value.removePrefix(TERMINAL_PREFIX)
        if (unprefixed in ENABLED_AGENT_IDS) return unprefixed
        return CLI_AGENT_ALIASES[unprefixed]
    }
}
