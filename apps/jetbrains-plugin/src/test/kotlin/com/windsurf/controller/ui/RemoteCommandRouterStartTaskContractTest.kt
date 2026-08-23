package com.windsurf.controller.ui

import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Contract guard for the `start_task` arm of [RemoteCommandRouter]
 * (2026-08-21 silent-black-hole replays).
 *
 * An UNDELIVERABLE prompt must produce a **"failed"** result — never a
 * "completed" with a clipboard-fallback message. The old behaviour
 * (`"completed"` + "Could not deliver prompt — copied to clipboard")
 * made the mobile/web apps render the turn as successfully dispatched:
 * the optimistic bubble stayed `sent`, "Thinking…" spun forever, and the
 * user's prompts vanished into the void.
 *
 * The router needs the full IntelliJ platform to instantiate, so this is
 * a source-level contract test (same pattern as
 * `protocol/ProtocolConstantsDriftTest`): parse the Kotlin source and
 * assert the failure path is a thrown [CommandFailed], not a completed
 * payload.
 */
class RemoteCommandRouterStartTaskContractTest {

    private fun routerSource(): String {
        val file = File(
            System.getProperty("user.dir"),
            "src/main/kotlin/com/windsurf/controller/ui/RemoteCommandRouter.kt",
        )
        assumeTrue("RemoteCommandRouter.kt not found at ${file.path}", file.isFile)
        return file.readText()
    }

    @Test
    fun `undeliverable start_task throws CommandFailed instead of completing`() {
        val src = routerSource()
        assertTrue(
            Regex("""if\s*\(\s*!sent\s*\)\s*\{\s*\n\s*throw CommandFailed""").containsMatchIn(src),
            "start_task must `throw CommandFailed` when the strategy could not deliver " +
                "(`!sent`) — a completed result for an undelivered prompt is the " +
                "2026-08-21 silent-black-hole bug.",
        )
    }

    @Test
    fun `the clipboard-fallback completed message is gone`() {
        val src = routerSource()
        assertFalse(
            src.contains("Could not deliver prompt — copied to clipboard"),
            "The clipboard-fallback text must not ride a 'completed' result — " +
                "an undelivered prompt is a failure the apps must render as one.",
        )
    }
}
