package com.windsurf.controller.services

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// Story - JetBrains plugin nudges the user to update when the
// marketplace ships a newer build, mirroring the CLI's auto-update
// advisory (apps/cli/src/lib/updateNotifier.ts) and the VS Code
// plugin's update banner (apps/vsc-plugin/src/services/
// update-notifier.service.ts).
//
// Why this test exists
// --------------------
// QA-reported regressions land in the next published build, but a
// user on an old build wouldn't know - JetBrains' auto-update is
// opt-in per-user and we have no other surface to nudge them. The
// user requested this verbatim: "como mismo lo hace el cli ...
// mostrar un banner en los plugins que recomiende actualizar para
// solucionar errores conocidos".
//
// Expected behaviour
// ------------------
// - latest > current AND dismissed != latest -> SHOW
// - latest <= current -> UP_TO_DATE (no banner)
// - dismissed == latest -> SUPPRESSED (Later sticks per-version)
// - dismissed != latest but latest > current -> SHOW (newer publish
//   re-surfaces the banner even after a prior Later)
// - semver compare ignores pre-release suffixes (-rc.N) so a stable
//   user is never nagged to install a pre-release.
class UpdateNotifierLogicTest {

    @Test
    fun `decides SHOW when latest is strictly newer`() {
        val outcome = UpdateNotifierLogic.decide(
            currentVersion = "2.10.8",
            latestVersion = "2.11.0",
            dismissedVersion = null,
        )
        assertEquals(UpdateNotifierLogic.Decision.SHOW, outcome)
    }

    @Test
    fun `decides UP_TO_DATE when current equals latest`() {
        val outcome = UpdateNotifierLogic.decide(
            currentVersion = "2.10.8",
            latestVersion = "2.10.8",
            dismissedVersion = null,
        )
        assertEquals(UpdateNotifierLogic.Decision.UP_TO_DATE, outcome)
    }

    @Test
    fun `decides UP_TO_DATE when current is newer than latest`() {
        val outcome = UpdateNotifierLogic.decide(
            currentVersion = "2.11.0",
            latestVersion = "2.10.8",
            dismissedVersion = null,
        )
        assertEquals(UpdateNotifierLogic.Decision.UP_TO_DATE, outcome)
    }

    @Test
    fun `decides SUPPRESSED when user already chose Later for this version`() {
        val outcome = UpdateNotifierLogic.decide(
            currentVersion = "2.10.8",
            latestVersion = "2.11.0",
            dismissedVersion = "2.11.0",
        )
        assertEquals(UpdateNotifierLogic.Decision.SUPPRESSED, outcome)
    }

    @Test
    fun `re-surfaces after a newer publish even when prior Later sticks`() {
        val outcome = UpdateNotifierLogic.decide(
            currentVersion = "2.10.8",
            latestVersion = "2.12.0",
            dismissedVersion = "2.11.0",
        )
        assertEquals(UpdateNotifierLogic.Decision.SHOW, outcome)
    }

    @Test
    fun `ignores pre-release suffixes in semver compare`() {
        // A stable user on 2.10.8 must not be nagged to install a
        // pre-release of 2.10.8 (e.g. 2.10.8-rc.1 is *not* newer).
        val outcome = UpdateNotifierLogic.decide(
            currentVersion = "2.10.8",
            latestVersion = "2.10.8-rc.1",
            dismissedVersion = null,
        )
        assertEquals(UpdateNotifierLogic.Decision.UP_TO_DATE, outcome)
    }

    @Test
    fun `parses marketplace JSON and returns the first entry's version`() {
        // Real shape of GET https://plugins.jetbrains.com/api/plugins/
        // com.codeagent.mobile/updates - array sorted by cdate
        // descending, so [0] is the latest published build.
        val json = """
            [
              { "version": "2.11.0", "cdate": "2026-06-05" },
              { "version": "2.10.8", "cdate": "2026-05-24" }
            ]
        """.trimIndent()
        val latest = UpdateNotifierLogic.parseLatestVersion(json)
        assertEquals("2.11.0", latest)
    }

    @Test
    fun `returns null when marketplace payload is malformed`() {
        assertEquals(null, UpdateNotifierLogic.parseLatestVersion(""))
        assertEquals(null, UpdateNotifierLogic.parseLatestVersion("not json"))
        assertEquals(null, UpdateNotifierLogic.parseLatestVersion("[]"))
        assertEquals(null, UpdateNotifierLogic.parseLatestVersion("[{}]"))
    }

    @Test
    fun `cache is fresh inside the 24h TTL and stale outside`() {
        val now = 1_700_000_000_000L
        assertTrue(UpdateNotifierLogic.isCacheFresh(now - 1_000L, now))
        assertTrue(
            !UpdateNotifierLogic.isCacheFresh(
                fetchedAt = now - 25 * 60 * 60 * 1000L,
                now = now,
            )
        )
    }
}
