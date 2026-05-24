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
    noExternal: ['@clack/prompts', '@clack/core'],
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
