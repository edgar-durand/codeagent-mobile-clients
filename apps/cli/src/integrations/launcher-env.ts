// src/integrations/launcher-env.ts
//
// Env every `npx`/`uvx` child of ours is launched with.
//
// ⚠️ WHY. `npx -y <pkg>` runs `npm audit` against the registry as part of
// installing into its cache (`POST /-/npm/v1/security/advisories/bulk`). On
// 2026-09-03 that one request took 268 s while every tarball fetch took under
// a second — a cold `npm install` of the same package finished in 3 s, the same
// package through `npx` in 5 minutes, and the server printed NOTHING meanwhile
// (the CI gate saw "no tools/list answer in 180 s, stderr: <empty>", twice).
// On a user's box the first start of a freshly linked integration sits in the
// same request, past the agent's `MCP_TIMEOUT`, and is filed as "not connected".
//
// An audit is meaningless for a runtime fetch of an exact-pinned package, so it
// is disabled through npm's env config — which `npx` honours and no argv has to
// carry. Fund/update-notifier are noise on the same path.
export const LAUNCHER_ENV: Readonly<Record<string, string>> = Object.freeze({
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_update_notifier: 'false',
});
