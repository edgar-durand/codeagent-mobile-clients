/**
 * Production API base URL for all CodeAgent Mobile clients.
 *
 * History note: prod migrated from Vercel (`https://api.codeagent-mobile.com`)
 * to Cloud Run / api-v2 (`https://api.codeagent-mobile.com`) in 2026-05. The
 * Vercel deployment is now gated by Vercel deployment protection and returns
 * 403 for unauthed traffic — DO NOT fall back to it.
 *
 * Override at runtime with `CODEAM_API_URL` (CLI) or the `apiBaseUrl` setting
 * (VS Code / JetBrains). When you need to point at a staging environment,
 * override the env var — do NOT change this constant.
 */
export const DEFAULT_API_BASE_URL = 'https://api.codeagent-mobile.com' as const;
