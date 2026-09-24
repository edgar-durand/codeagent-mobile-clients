package com.windsurf.controller.services

import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Regression (2026-09-23): every JetBrains session was titled with the LITERAL
 * text of a Kotlin template.
 *
 * `PairingService.requestPairingCode` built `repoIdentifier` with the
 * `${'$'}` escape — the idiom for emitting a literal `$` into JS/JSON — so
 * instead of interpolating `it.owner` / `it.repo` it sent the source text
 * verbatim, and the apps (which title a session by its repo) showed
 * "dollar-brace it.repo" on every card. Seen in a real user's screen
 * recording; the same escape also garbled the no-git-context log line.
 */
class RepoIdentifierTest {
    @Test
    fun `identifier interpolates owner and repo`() {
        assertEquals(
            "edgar-durand/codeagent-mobile-clients",
            RepoSlug(owner = "edgar-durand", repo = "codeagent-mobile-clients").identifier,
        )
    }

    /**
     * The plugin has NO legitimate use of the `${'$'}{` escape today: the only
     * two occurrences were this bug. Any new one in main sources is almost
     * certainly the same mistake, so fail loudly and point at it.
     */
    @Test
    fun `no main Kotlin source escapes a template with the dollar idiom`() {
        val mainKotlin = resolveMainKotlinDir()
        assumeTrue("plugin sources not found from ${System.getProperty("user.dir")}", mainKotlin != null)
        val needle = "\${'\$'}{"
        val offenders = mainKotlin!!.walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .flatMap { file ->
                file.readLines().withIndex()
                    .filter { (_, line) -> line.contains(needle) }
                    .map { (idx, _) -> "${file.relativeTo(mainKotlin)}:${idx + 1}" }
            }
            .toList()
        assertTrue(
            offenders.isEmpty(),
            "Kotlin string templates escaped as a literal (the pairing-title bug): $offenders",
        )
    }

    /** Walk up from the working dir until `src/main/kotlin` of this plugin resolves. */
    private fun resolveMainKotlinDir(): File? {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            val candidate = File(dir, "src/main/kotlin/com/windsurf/controller")
            if (candidate.isDirectory) return candidate
            val nested = File(dir, "apps/jetbrains-plugin/src/main/kotlin/com/windsurf/controller")
            if (nested.isDirectory) return nested
            dir = dir.parentFile
        }
        return null
    }
}
