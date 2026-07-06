package com.windsurf.controller.util

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Pins the Kotlin port of the VS Code extension's registry-driven
 * agent-id normalizer (apps/vsc-plugin/src/utils/cli-agent-id.ts).
 *
 * Background — what we're guarding against: the router used to
 * whitelist only claude/codex and silently rewrote every other agent
 * choice (gemini → dropped on pair, cursor → substituted with claude
 * on link). The normalizer covers all enabled agents plus the alias
 * spellings mobile/web actually send, and unknown ids come back as
 * `null` so the router can fail loudly instead.
 */
class CliAgentIdTest {

    @Test
    fun `canonical enabled ids pass through`() {
        for (id in listOf("claude", "codex", "gemini", "cursor", "aider", "coderabbit")) {
            assertEquals(id, CliAgentId.normalizeCliAgentId(id), id)
        }
    }

    @Test
    fun `copilot is a known id but disabled in the registry`() {
        assertNull(CliAgentId.normalizeCliAgentId("copilot"))
    }

    @Test
    fun `aliases map to canonical ids`() {
        assertEquals("claude", CliAgentId.normalizeCliAgentId("claude_code"))
        assertEquals("claude", CliAgentId.normalizeCliAgentId("claude-code"))
        assertEquals("claude", CliAgentId.normalizeCliAgentId("anthropic.claude-code"))
        assertEquals("claude", CliAgentId.normalizeCliAgentId("com.anthropic.claudecode"))
        assertEquals("codex", CliAgentId.normalizeCliAgentId("openai.chatgpt"))
        assertEquals("coderabbit", CliAgentId.normalizeCliAgentId("coderabbitai.coderabbit-vscode"))
    }

    @Test
    fun `terminal prefix is stripped before lookup`() {
        assertEquals("gemini", CliAgentId.normalizeCliAgentId("__terminal__:gemini"))
        assertEquals("claude", CliAgentId.normalizeCliAgentId("__terminal__:claude_code"))
    }

    @Test
    fun `input is trimmed and lowercased`() {
        assertEquals("codex", CliAgentId.normalizeCliAgentId("  Codex "))
        assertEquals("claude", CliAgentId.normalizeCliAgentId("CLAUDE_CODE"))
    }

    @Test
    fun `unknown, blank, and null ids return null`() {
        assertNull(CliAgentId.normalizeCliAgentId("not-an-agent"))
        assertNull(CliAgentId.normalizeCliAgentId("claude; rm -rf /"))
        assertNull(CliAgentId.normalizeCliAgentId(""))
        assertNull(CliAgentId.normalizeCliAgentId("   "))
        assertNull(CliAgentId.normalizeCliAgentId(null))
    }
}
