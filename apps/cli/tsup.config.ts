import { defineConfig } from 'tsup';
import path from 'node:path';
import type { BuildOptions } from 'esbuild';
import pkg from './package.json';

// `@codeam/shared` is bundled from its workspace SOURCE, exactly as it
// was when the package's `main` pointed at `src/index.ts`. Since the
// package became publishable its manifest (`exports`/`main`) points at
// `dist/`, which esbuild would otherwise resolve — silently switching the
// CLI bundle to whatever stale `dist/` happens to be on disk and adding a
// build-order dependency. This alias pins resolution to the source entry.
// Mirrors: apps/vsc-plugin/esbuild.js (alias), each app's tsconfig
// (`paths`) and vitest config (`resolve.alias`).
const SHARED_SRC = path.join(__dirname, '..', '..', 'packages', 'shared', 'src', 'index.ts');
const aliasSharedToSource = (options: BuildOptions) => {
  options.alias = { ...options.alias, '@codeam/shared': SHARED_SRC };
};

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
    esbuildOptions: aliasSharedToSource,
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
    esbuildOptions: aliasSharedToSource,
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    // Headroom integration-test driver — invoked INSIDE the Docker container
    // by `headroom-provision.int.test.ts`. Not part of the published CLI
    // surface; compiled separately so the test can `node dist/headroom-runner-driver.js`
    // against the REAL provisioning code without mocking pip / headroom init.
    entry: ['src/headroom-runner-driver.ts'],
    format: ['cjs'],
    target: 'node20',
    noExternal: ['@clack/prompts', '@clack/core', '@agentclientprotocol/sdk'],
    external: ['node-pty'],
    esbuildOptions: aliasSharedToSource,
    // No banner: this file is invoked as `node dist/headroom-runner-driver.js`
    // (not as a directly-executable script), so it intentionally has NO shebang.
    // Unlike the `index.ts` and `postinstall.ts` entries (which keep their
    // `#!/usr/bin/env node` banner so the OS can exec them directly), the
    // driver is never exec'd — a shebang would be dead weight and would
    // produce a double-shebang if the source file ever grew one.
    define: {
      __CLI_VERSION__: JSON.stringify(pkg.version),
      __POSTHOG_API_KEY__: JSON.stringify(process.env.POSTHOG_API_KEY ?? ''),
      __POSTHOG_HOST__: JSON.stringify(
        process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com',
      ),
    },
  },
]);
