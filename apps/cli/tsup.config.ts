import { defineConfig } from 'tsup';
import pkg from './package.json';

// Single source of truth for the version: package.json. tsup's
// `define` substitutes the `__CLI_VERSION__` literal in our source
// at build time so `codeam --version` always matches what npm
// published (the release pipeline patches package.json first).
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['cjs'],
    target: 'node18',
    clean: true,
    // `@agentclientprotocol/sdk` is ESM-only (`"type": "module"`). Node
    // 22+ supports require()-ing ESM by default, but Node 20 LTS — which
    // the codespace-docker-e2e integration suite runs on AND a chunk
    // of CLI installs out there are still on — throws ERR_REQUIRE_ESM.
    // Inlining the SDK via noExternal sidesteps the runtime require:
    // tsup transpiles the SDK to CJS during the bundle step and the
    // produced `dist/index.js` runs cleanly on every supported Node.
    noExternal: ['@clack/prompts', '@clack/core', '@agentclientprotocol/sdk'],
    // `node-pty` MUST stay external. Bundling it inlines
    // `unixTerminal.js`, whose top-level `loadNativeModule('pty.node')`
    // fires the instant `dist/index.js` is required — crashing
    // the CLI before any command runs (regression observed on
    // darwin-arm64 in 2.10.x). External keeps `require('node-pty')`
    // as a runtime call resolved against the vendored copy at
    // `dist/vendor/node-pty/`, so the dlopen only happens when an
    // IDE terminal panel actually opens.
    external: ['node-pty'],
    banner: { js: '#!/usr/bin/env node' },
    define: {
      __CLI_VERSION__: JSON.stringify(pkg.version),
      // PostHog ingestion key — public-by-design (same shape mobile +
      // landing bake at build time). The release pipeline sets
      // POSTHOG_API_KEY in CI; local builds leave it empty, which the
      // telemetry service treats as "no-op" (everything captured falls
      // into the void). __POSTHOG_HOST__ defaults to PostHog's US
      // ingestion endpoint to match the apps.
      __POSTHOG_API_KEY__: JSON.stringify(process.env.POSTHOG_API_KEY ?? ''),
      __POSTHOG_HOST__: JSON.stringify(
        process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com',
      ),
    },
  },
  {
    entry: ['src/postinstall.ts'],
    format: ['cjs'],
    target: 'node18',
    banner: { js: '#!/usr/bin/env node' },
  },
]);
