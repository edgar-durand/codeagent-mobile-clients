/**
 * Entry point for the VS Code extension E2E suite.
 *
 * Downloads the requested VS Code build (matching our `engines.vscode`
 * floor + the latest stable) into `.vscode-test/`, then spawns it
 * with our packaged extension and the Mocha test runner that lives at
 * `dist-test/test/suite/index.js`.
 *
 * Designed to run on the GitHub Actions `ubuntu-latest` runner under
 * `xvfb-run -a` — VS Code is an Electron app and needs a display
 * server. macOS / Windows also work locally without xvfb.
 *
 * Env vars:
 *   CODEAM_VSC_TEST=1   activates the test-only command in extension.ts.
 *                       Set automatically here so callers don't have to.
 *   CODEAM_API_URL      override the backend base URL (defaults to prod).
 */

import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  try {
    // The extensionDevelopmentPath is the folder containing
    // package.json. VS Code loads it as a workspace extension at
    // startup, the same way the marketplace loader would.
    const extensionDevelopmentPath = path.resolve(__dirname, '..', '..', '..');
    // The compiled suite entry. Mocha loads from here.
    const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.js');

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // `--disable-extensions` keeps the user's installed extensions
      // out of the test session so we can rely on a clean baseline.
      // The dev path is still loaded, so OUR extension is active.
      launchArgs: ['--disable-extensions'],
      extensionTestsEnv: {
        CODEAM_VSC_TEST: '1',
        // Mocha colour escapes confuse the GitHub Actions log when
        // run under xvfb-run. NO_COLOR keeps the output grep-friendly.
        NO_COLOR: '1',
      },
    });
  } catch (err) {
    console.error('E2E run failed:', err);
    process.exit(1);
  }
}

void main();
