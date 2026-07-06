package com.windsurf.controller.protocol

import org.junit.Assume.assumeTrue
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

/**
 * Guards the TS ↔ Kotlin protocol-constants mirror (audit J6).
 *
 * `protocol/Constants.kt` mirrors
 * `packages/shared/src/protocol/constants.ts` by convention only —
 * Kotlin can't import the npm package, so nothing stopped the two
 * sides from drifting silently. A drifted PROTOCOL_VERSION means the
 * backend 426s the JB client at the next protocol sweep.
 *
 * This test parses the TS source at test time and asserts each mirrored
 * value. When the shared repo isn't checked out next to the plugin
 * (standalone build), the test is skipped via assumeTrue.
 */
class ProtocolConstantsDriftTest {

    private val tsRelativePath = "packages/shared/src/protocol/constants.ts"

    private fun tsSource(): String {
        val file = ClientsRepoFiles.resolve(tsRelativePath)
        assumeTrue(
            "Skipping drift check: $tsRelativePath not found above ${System.getProperty("user.dir")} " +
                "(plugin built standalone, outside the codeagent-mobile-clients monorepo)",
            file != null,
        )
        return file!!.readText()
    }

    /** Extracts `export const NAME = <'string' | number>` from the TS source. */
    private fun tsConst(source: String, name: String): String {
        val match = Regex("""export\s+const\s+$name\s*=\s*('([^']*)'|[0-9][0-9_]*)""").find(source)
        assertNotNull(
            match,
            "Could not find `export const $name = …` in $tsRelativePath — " +
                "if the constant was renamed/removed there, update protocol/Constants.kt (and this test) to match.",
        )
        val quoted = match.groupValues[2]
        return if (match.groupValues[1].startsWith("'")) quoted else match.groupValues[1].replace("_", "")
    }

    private fun driftMessage(name: String, tsValue: String, ktValue: String): String =
        "$name drifted: $tsRelativePath has $tsValue but the Kotlin mirror " +
            "(apps/jetbrains-plugin/src/main/kotlin/com/windsurf/controller/protocol/Constants.kt) has $ktValue. " +
            "Update whichever side lagged — a TS bump must propagate to the Kotlin mirror and vice versa."

    @Test
    fun `PROTOCOL_VERSION matches the TS shared constant`() {
        val ts = tsConst(tsSource(), "PROTOCOL_VERSION")
        assertEquals(ts, PROTOCOL_VERSION, driftMessage("PROTOCOL_VERSION", "'$ts'", "'$PROTOCOL_VERSION'"))
    }

    @Test
    fun `OBSERVER_BRIDGE_PORT matches the TS shared constant`() {
        val ts = tsConst(tsSource(), "OBSERVER_BRIDGE_PORT").toInt()
        assertEquals(ts, OBSERVER_BRIDGE_PORT, driftMessage("OBSERVER_BRIDGE_PORT", "$ts", "$OBSERVER_BRIDGE_PORT"))
    }

    @Test
    fun `HEARTBEAT_INTERVAL_MS_DEFAULT matches the TS shared constant`() {
        val ts = tsConst(tsSource(), "HEARTBEAT_INTERVAL_MS_DEFAULT").toLong()
        assertEquals(
            ts,
            HEARTBEAT_INTERVAL_MS_DEFAULT,
            driftMessage("HEARTBEAT_INTERVAL_MS_DEFAULT", "$ts", "$HEARTBEAT_INTERVAL_MS_DEFAULT"),
        )
    }

    @Test
    fun `SSE_SOCKET_TIMEOUT_MS matches the TS shared constant`() {
        val ts = tsConst(tsSource(), "SSE_SOCKET_TIMEOUT_MS").toLong()
        assertEquals(ts, SSE_SOCKET_TIMEOUT_MS, driftMessage("SSE_SOCKET_TIMEOUT_MS", "$ts", "$SSE_SOCKET_TIMEOUT_MS"))
    }
}
