package com.windsurf.controller.protocol

import org.junit.Assume.assumeTrue
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Guards the JB `list_models` fallback catalog against drift from the
 * CLI's Claude model list (audit J4).
 *
 * The catalog ids live in `apps/cli/src/agents/claude/runtime.ts`
 * (`listModels()` on the Claude runtime strategy — NOT
 * `apps/cli/src/commands/start/handlers.ts`, whose `list_models`
 * handler only delegates to the runtime). The JB mirror is
 * `CLI_FALLBACK_MODELS` in protocol/CliFallbackModels.kt.
 *
 * Skipped (assumeTrue) when the CLI sources aren't checked out next to
 * the plugin (standalone build).
 */
class CliModelCatalogDriftTest {

    private val cliRuntimePath = "apps/cli/src/agents/claude/runtime.ts"
    private val pricingPath = "packages/shared/src/models/pricing.ts"

    /** Model ids inside the `listModels()` array literal of the CLI's Claude runtime. */
    private fun cliModelIds(): Set<String> {
        val file = ClientsRepoFiles.resolve(cliRuntimePath)
        assumeTrue(
            "Skipping drift check: $cliRuntimePath not found above ${System.getProperty("user.dir")} " +
                "(plugin built standalone, outside the codeagent-mobile-clients monorepo)",
            file != null,
        )
        val source = file!!.readText()
        val start = source.indexOf("listModels")
        assertTrue(
            start >= 0,
            "Could not find `listModels` in $cliRuntimePath — if the CLI moved its Claude model catalog, " +
                "update this test's parser AND the pointer comments in RemoteCommandRouter.kt / CliFallbackModels.kt.",
        )
        val end = source.indexOf("];", start)
        assertTrue(end > start, "Could not find the end of the listModels() array literal in $cliRuntimePath.")
        val ids = Regex("""id:\s*'([^']+)'""")
            .findAll(source.substring(start, end))
            .map { it.groupValues[1] }
            .toSet()
        assertTrue(ids.isNotEmpty(), "Parsed zero model ids out of listModels() in $cliRuntimePath — parser drifted?")
        return ids
    }

    @Test
    fun `JB fallback catalog ids match the CLI Claude runtime listModels ids`() {
        val cliIds = cliModelIds()
        val jbIds = CLI_FALLBACK_MODELS.map { it.id }.toSet()
        assertEquals(
            cliIds,
            jbIds,
            "CLI fallback model catalog drifted.\n" +
                "  CLI ($cliRuntimePath listModels()): ${cliIds.sorted()}\n" +
                "  JB  (protocol/CliFallbackModels.kt CLI_FALLBACK_MODELS): ${jbIds.sorted()}\n" +
                "If the CLI added/renamed a Claude model, mirror it in CLI_FALLBACK_MODELS; " +
                "if the JB side changed unilaterally, revert it or land the CLI change first.",
        )
    }

    @Test
    fun `JB fallback default model id is in the catalog`() {
        assertTrue(
            CLI_FALLBACK_MODELS.any { it.id == CLI_FALLBACK_DEFAULT_MODEL_ID },
            "CLI_FALLBACK_DEFAULT_MODEL_ID ('$CLI_FALLBACK_DEFAULT_MODEL_ID') is not one of CLI_FALLBACK_MODELS — " +
                "the list_models fallback would mark nothing isDefault.",
        )
    }

    @Test
    fun `every JB fallback id resolves against the shared pricing table by prefix`() {
        val file = ClientsRepoFiles.resolve(pricingPath)
        assumeTrue(
            "Skipping pricing check: $pricingPath not found above ${System.getProperty("user.dir")}",
            file != null,
        )
        // getPricing() resolves by longest-prefix match, so
        // 'claude-haiku-4-5-20251001' is priced by the 'claude-haiku-4-5'
        // row. Assert each fallback id has SOME prefix row.
        val pricingKeys = Regex("""'(claude-[^']+)':""")
            .findAll(file!!.readText())
            .map { it.groupValues[1] }
            .toSet()
        assertTrue(pricingKeys.isNotEmpty(), "Parsed zero claude-* keys out of $pricingPath — parser drifted?")
        for (model in CLI_FALLBACK_MODELS) {
            assertTrue(
                pricingKeys.any { model.id.startsWith(it) },
                "JB fallback model '${model.id}' has no prefix row in $pricingPath (keys: ${pricingKeys.sorted()}) — " +
                    "sessions on this model would meter at the unknown-model fallback rate. Add a pricing row.",
            )
        }
    }
}
