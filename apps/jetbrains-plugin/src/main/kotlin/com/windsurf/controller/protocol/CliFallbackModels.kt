package com.windsurf.controller.protocol

/**
 * CLI fallback model catalog surfaced by the `list_models` arm when
 * Copilot's live catalog isn't available (RemoteCommandRouter).
 *
 * Kotlin mirror of the Claude runtime's hardcoded list in
 * `apps/cli/src/agents/claude/runtime.ts` (`listModels()`) — NOT
 * `apps/cli/src/commands/start/handlers.ts`, which only delegates to
 * the runtime strategy. Kotlin can't import the CLI's TypeScript, so
 * this list is a deliberate port; `CliModelCatalogDriftTest` parses
 * the TS source at test time and fails the build when the two sides
 * drift.
 */
data class CliFallbackModel(
    val id: String,
    val label: String,
    val description: String,
)

val CLI_FALLBACK_MODELS = listOf(
    CliFallbackModel("claude-opus-4-7", "Claude Opus 4.7", "Most capable"),
    CliFallbackModel("claude-opus-4-6", "Claude Opus 4.6", "Top tier"),
    CliFallbackModel("claude-sonnet-4-6", "Claude Sonnet 4.6", "Balanced"),
    CliFallbackModel("claude-haiku-4-5-20251001", "Claude Haiku 4.5", "Fastest"),
)

/** The id the `list_models` fallback marks `isDefault: true`. */
const val CLI_FALLBACK_DEFAULT_MODEL_ID = "claude-sonnet-4-6"
