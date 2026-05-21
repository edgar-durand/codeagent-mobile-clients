package com.windsurf.controller

/**
 * SYNC WITH packages/shared/src/api-url.ts
 *
 * Production API base URL for all CodeAgent Mobile clients. See the
 * TypeScript file at the path above for the canonical version + history
 * (Vercel → Cloud Run migration in 2026-05).
 *
 * Override at runtime via Settings → Tools → CodeAgent Mobile → API Base URL.
 */
const val DEFAULT_API_BASE_URL: String = "https://api.codeagent-mobile.com"
