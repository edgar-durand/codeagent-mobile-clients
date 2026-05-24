package com.windsurf.controller

/**
 * SYNC WITH packages/shared/src/api-url.ts
 *
 * Production API base URL for all CodeAgent Mobile clients. See the
 * TypeScript file at the path above for the canonical version + history
 * (Vercel → Cloud Run migration in 2026-05).
 *
 * Override at runtime via Settings → Tools → CodeAgent Mobile → API Base URL,
 * or set the `CODEAM_TEST_MODE=1` env var (Cmd+Shift+P → Edit Custom
 * Properties → restart IDE on JetBrains; on VS Code it's the same env
 * vars the CLI reads).
 */
const val DEFAULT_API_BASE_URL: String = "https://api.codeagent-mobile.com"

/**
 * Dev-preview API base URL — matches `DEV_API_BASE_URL` in
 * `packages/shared/src/api-url.ts`. Used when `CODEAM_TEST_MODE=1`.
 */
const val DEV_API_BASE_URL: String = "https://dev-api.codeagent-mobile.com"

/**
 * Resolve the active API base URL with the same priority the TS
 * shared package uses:
 *
 *   1. `CODEAM_API_URL` env var (full URL override).
 *   2. `CODEAM_TEST_MODE=1` shortcut (→ [DEV_API_BASE_URL]).
 *   3. [DEFAULT_API_BASE_URL].
 *
 * Read once at SettingsService construction so the env var flip needs
 * an IDE restart (matches the way `apiBaseUrl` is cached in @State).
 */
fun resolveApiBaseUrl(): String {
    val explicit = System.getenv("CODEAM_API_URL")?.trim()
    if (!explicit.isNullOrEmpty()) return explicit
    val testFlag = System.getenv("CODEAM_TEST_MODE")?.trim()
    if (testFlag == "1" || testFlag?.lowercase() == "true") return DEV_API_BASE_URL
    return DEFAULT_API_BASE_URL
}
