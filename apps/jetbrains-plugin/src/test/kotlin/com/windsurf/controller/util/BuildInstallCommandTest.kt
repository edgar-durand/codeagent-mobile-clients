package com.windsurf.controller.util

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Cross-OS coverage for the install-then-run one-liner the
 * "Pair from mobile" / "Link agent" flows send to the freshly-opened
 * JetBrains terminal.
 *
 * Background — what we're guarding against (v2.17.x regression):
 *
 *     npm install -g codeam-cli@latest && codeam pair || npx -y …
 *
 * `&&` and `||` as pipeline-chain operators were only added in
 * PowerShell 7. PowerShell 5.x — the default shell on every fresh
 * Windows 10/11 install — parses `&&` as an "invalid statement
 * separator" and the command dies before npm runs. JetBrains
 * terminals on Windows default to PowerShell, so a tap on "Pair"
 * from mobile would show the user a PowerShell ParserError instead
 * of a paired session.
 *
 * The fix branches on `os.name`: Windows gets the semicolon +
 * `$LASTEXITCODE` form (works in PS 5.x AND PS 7+); macOS / Linux /
 * WSL keep the original `&&`/`||` form. These tests pin every branch
 * so any future tweak that drops PS 5.x compatibility is caught at
 * CI time, before a tag.
 */
class BuildInstallCommandTest {

    @Test
    fun `Windows 10 emits semicolon + LASTEXITCODE form (no && or ||)`() {
        val cmd = BuildInstallCommand.forSubcommand("pair", "Windows 10")
        assertTrue(cmd.contains("npm install -g codeam-cli@latest;"), cmd)
        assertTrue(cmd.contains("\$LASTEXITCODE"), cmd)
        assertTrue(cmd.contains("codeam pair"), cmd)
        assertTrue(cmd.contains("npx -y codeam-cli@latest pair"), cmd)
        // Critical: PS 5.x can't parse these.
        assertFalse(cmd.contains("&&"), "Windows command must not use && (PS 5.x fails to parse it)")
        assertFalse(cmd.contains("||"), "Windows command must not use || (PS 5.x fails to parse it)")
    }

    @Test
    fun `Windows 11 picks the same branch (case-insensitive os name match)`() {
        val cmd = BuildInstallCommand.forSubcommand("pair", "Windows 11")
        assertTrue(cmd.contains("\$LASTEXITCODE"), cmd)
        assertFalse(cmd.contains("&&"))
    }

    @Test
    fun `Windows Server 2022 also routes to PowerShell-safe form`() {
        val cmd = BuildInstallCommand.forSubcommand("pair", "Windows Server 2022")
        assertTrue(cmd.contains("\$LASTEXITCODE"), cmd)
        assertFalse(cmd.contains("&&"))
    }

    @Test
    fun `os name lowercased still detects Windows (defence-in-depth)`() {
        // os.name doesn't actually come out lower-cased on Windows
        // — JVM always returns "Windows 10" / "Windows 11" — but the
        // `startsWith("Windows", ignoreCase = true)` check should
        // tolerate any variant in case a non-Oracle JVM ever differs.
        val cmd = BuildInstallCommand.forSubcommand("pair", "windows 11")
        assertTrue(cmd.contains("\$LASTEXITCODE"))
    }

    @Test
    fun `macOS keeps amp-amp and pipe-pipe one-liner`() {
        val cmd = BuildInstallCommand.forSubcommand("pair", "Mac OS X")
        assertEquals(
            "npm install -g codeam-cli@latest && codeam pair || npx -y codeam-cli@latest pair",
            cmd,
        )
    }

    @Test
    fun `Linux keeps amp-amp and pipe-pipe one-liner`() {
        val cmd = BuildInstallCommand.forSubcommand("pair", "Linux")
        assertEquals(
            "npm install -g codeam-cli@latest && codeam pair || npx -y codeam-cli@latest pair",
            cmd,
        )
    }

    @Test
    fun `link codex subcommand passes through on Windows`() {
        val cmd = BuildInstallCommand.forSubcommand("link codex", "Windows 11")
        assertTrue(cmd.contains("codeam link codex"), cmd)
        assertTrue(cmd.contains("npx -y codeam-cli@latest link codex"), cmd)
        assertFalse(cmd.contains("&&"))
    }

    @Test
    fun `link claude subcommand passes through on Linux`() {
        val cmd = BuildInstallCommand.forSubcommand("link claude", "Linux")
        assertEquals(
            "npm install -g codeam-cli@latest && codeam link claude || npx -y codeam-cli@latest link claude",
            cmd,
        )
    }
}
