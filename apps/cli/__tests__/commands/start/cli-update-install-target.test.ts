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

  // These two layouts are POSIX-only BY CONSTRUCTION — codespaces are Linux
  // boxes (`/tmp/codeam-node20` is the Linux bootstrap prefix) and nvm is a
  // POSIX shell tool (nvm-windows uses a different, lib-less layout). On
  // win32 the sibling-npm probe correctly builds `<dir>\npm.cmd` via the
  // native path module, so the POSIX `<dir>/npm` fixtures can never match —
  // the win32-native expectations are pinned in the describe below instead.
  it.skipIf(process.platform === 'win32')(
    'codespace layout: targets the running prefix and the sibling npm',
    () => {
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
    },
  );

  it.skipIf(process.platform === 'win32')(
    'standard global layout (nvm): prefix derived from the entry script',
    () => {
      const home = '/Users/u/.nvm/versions/node/v20.11.0';
      const inv = buildNpmInstallInvocation({
        entryScript: path.join(home, 'lib/node_modules/codeam-cli/dist/index.js'),
        execPath: path.join(home, 'bin/node'),
        existsSync: (p: string) => p === path.join(home, 'bin/npm'),
      });
      expect(inv.command).toBe(path.join(home, 'bin/npm'));
      expect(inv.args).toContain('--prefix');
      expect(inv.args).toContain(home);
    },
  );

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

// Windows-native expectations — the behavior a real Windows CLI user gets.
// buildNpmInstallInvocation intentionally derives the sibling npm name and
// path semantics from the HOST platform (native `path` + process.platform),
// so these cases can only run under win32 — and windows-latest is in the CI
// matrix, so they DO run there on every push. What they pin:
//   - Windows global npm layouts have NO `lib/` segment
//     (`%APPDATA%\npm\node_modules\codeam-cli\...`,
//     `...\nvm\v20.11.0\node_modules\codeam-cli\...` for nvm-windows), so the
//     POSIX `/lib/node_modules/codeam-cli/` marker never matches and no
//     `--prefix` is passed. That is CORRECT on Windows: the preferred command
//     is the `npm.cmd` sibling of the running node.exe, and that npm's own
//     global prefix already targets the install the daemon runs from (the
//     node MSI's builtin npmrc → %APPDATA%\npm; nvm-windows → the active
//     version dir). Forcing a POSIX-derived --prefix would be wrong there.
//   - The sibling probe looks for `npm.cmd` (not `npm`) next to node.exe.
describe.runIf(process.platform === 'win32')(
  'buildNpmInstallInvocation — win32-native behavior',
  () => {
    it('standard Windows global layout: sibling npm.cmd, no --prefix', () => {
      const nodeDir = 'C:\\Program Files\\nodejs';
      const inv = buildNpmInstallInvocation({
        entryScript:
          'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\codeam-cli\\dist\\index.js',
        execPath: path.join(nodeDir, 'node.exe'),
        existsSync: (p: string) => p === path.join(nodeDir, 'npm.cmd'),
      });
      expect(inv.command).toBe(path.join(nodeDir, 'npm.cmd'));
      expect(inv.args).toEqual(['install', '-g', 'codeam-cli@latest']);
    });

    it('nvm-windows layout: npm.cmd sibling of the running node version, no --prefix', () => {
      const versionDir = 'C:\\Users\\u\\AppData\\Roaming\\nvm\\v20.11.0';
      const inv = buildNpmInstallInvocation({
        entryScript: path.join(versionDir, 'node_modules\\codeam-cli\\dist\\index.js'),
        execPath: path.join(versionDir, 'node.exe'),
        existsSync: (p: string) => p === path.join(versionDir, 'npm.cmd'),
      });
      expect(inv.command).toBe(path.join(versionDir, 'npm.cmd'));
      expect(inv.args).toEqual(['install', '-g', 'codeam-cli@latest']);
    });

    it('no npm.cmd sibling: falls back to bare npm', () => {
      const inv = buildNpmInstallInvocation({
        entryScript:
          'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\codeam-cli\\dist\\index.js',
        execPath: 'C:\\Program Files\\nodejs\\node.exe',
        existsSync: () => false,
      });
      expect(inv.command).toBe('npm');
      expect(inv.args).toEqual(['install', '-g', 'codeam-cli@latest']);
    });
  },
);

import { isPermissionError } from '../../../src/commands/start/handlers';

describe('buildNpmInstallInvocation — sudo escalation (self-hosted root-owned prefix)', () => {
  it('prepends sudo -n and passes the resolved npm + args through', () => {
    const inv = buildNpmInstallInvocation({
      entryScript: '/usr/lib/node_modules/codeam-cli/dist/index.js',
      execPath: '/usr/bin/node',
      existsSync: (p: string) => p === '/usr/bin/npm',
      sudo: true,
    });
    expect(inv.command).toBe('sudo');
    expect(inv.args).toEqual(['-n', '/usr/bin/npm', 'install', '-g', '--prefix', '/usr', 'codeam-cli@latest']);
  });
  it('without sudo runs npm directly (unchanged)', () => {
    const inv = buildNpmInstallInvocation({
      entryScript: '/usr/lib/node_modules/codeam-cli/dist/index.js',
      execPath: '/usr/bin/node',
      existsSync: (p: string) => p === '/usr/bin/npm',
    });
    expect(inv.command).toBe('/usr/bin/npm');
    expect(inv.args[0]).toBe('install');
  });
});

describe('isPermissionError', () => {
  it('detects EACCES / errno -13 / permission denied', () => {
    expect(isPermissionError('npm error code EACCES')).toBe(true);
    expect(isPermissionError('npm error errno -13')).toBe(true);
    expect(isPermissionError('EACCES: permission denied, rename')).toBe(true);
    expect(isPermissionError('operation not permitted')).toBe(true);
  });
  it('does NOT match a transient network error', () => {
    expect(isPermissionError('ETIMEDOUT request to registry')).toBe(false);
    expect(isPermissionError('ENOTFOUND registry.npmjs.org')).toBe(false);
  });
});
