/**
 * cli_self_update — the install must land in the SAME prefix the running
 * CLI executes from (2026-07-04 "Some sessions may need a manual update").
 *
 * On a codespace the CLI daemon runs from the bootstrap prefix
 * `/tmp/codeam-node20/lib/node_modules/codeam-cli/...`, but the old
 * updater ran bare `npm install -g codeam-cli@latest`, which resolves
 * npm from the DAEMON's PATH and installs into the SYSTEM prefix
 * (nvm/user). The update landed elsewhere, the re-exec relaunched the
 * OLD binary from /tmp, the process reconnected still-outdated, the
 * banner never cleared, and after 90 s the app showed the manual-update
 * fallback.
 *
 * Contract pinned here (via buildNpmInstallInvocation, DI'd):
 *   - global npm layout (<prefix>/lib/node_modules/codeam-cli/...): npm
 *     runs with `--prefix <prefix>` so the update replaces the running
 *     install in place.
 *   - npm binary: prefer the sibling of process.execPath (the daemon may
 *     have no npm on PATH); fall back to bare `npm`.
 *   - non-global layouts (dev checkout): no --prefix (unchanged behavior).
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import { buildNpmInstallInvocation } from '../../../src/commands/start/handlers';

describe('buildNpmInstallInvocation — install target', () => {
  const CS_ENTRY =
    '/tmp/codeam-node20/lib/node_modules/codeam-cli/dist/index.js';
  const CS_NODE = '/tmp/codeam-node20/bin/node';

  it('codespace layout: targets the running prefix and the sibling npm', () => {
    const inv = buildNpmInstallInvocation({
      entryScript: CS_ENTRY,
      execPath: CS_NODE,
      existsSync: (p: string) => p === '/tmp/codeam-node20/bin/npm',
    });
    expect(inv.command).toBe('/tmp/codeam-node20/bin/npm');
    expect(inv.args).toEqual([
      'install',
      '-g',
      '--prefix',
      '/tmp/codeam-node20',
      'codeam-cli@latest',
    ]);
  });

  it('standard global layout (nvm): prefix derived from the entry script', () => {
    const home = '/Users/u/.nvm/versions/node/v20.11.0';
    const inv = buildNpmInstallInvocation({
      entryScript: path.join(home, 'lib/node_modules/codeam-cli/dist/index.js'),
      execPath: path.join(home, 'bin/node'),
      existsSync: (p: string) => p === path.join(home, 'bin/npm'),
    });
    expect(inv.command).toBe(path.join(home, 'bin/npm'));
    expect(inv.args).toContain('--prefix');
    expect(inv.args).toContain(home);
  });

  it('falls back to bare npm when no sibling npm exists', () => {
    const inv = buildNpmInstallInvocation({
      entryScript: CS_ENTRY,
      execPath: CS_NODE,
      existsSync: () => false,
    });
    expect(inv.command).toBe('npm');
    // Prefix targeting still applies — PATH npm + explicit prefix is safe.
    expect(inv.args).toContain('--prefix');
  });

  it('dev checkout (no global node_modules layout): bare npm, no prefix', () => {
    const inv = buildNpmInstallInvocation({
      entryScript: '/Users/u/dev/codeagent-mobile-clients/apps/cli/dist/index.js',
      execPath: '/usr/local/bin/node',
      existsSync: () => false,
    });
    expect(inv.command).toBe('npm');
    expect(inv.args).toEqual(['install', '-g', 'codeam-cli@latest']);
  });
});
