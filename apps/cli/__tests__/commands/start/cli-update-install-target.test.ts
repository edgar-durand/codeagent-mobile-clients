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
 *
 * ⚠️ Every case injects `platform` (+ asserts with the matching
 * `path.posix` / `path.win32`) so BOTH the POSIX and the win32 npm-name /
 * path resolution are exercised DETERMINISTICALLY on every CI OS — no leg
 * of the matrix skips the other platform's cases (the old `skipIf`/`runIf`
 * gating left the Windows runner failing the POSIX sudo cases).
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import { buildNpmInstallInvocation, isPermissionError } from '../../../src/commands/start/handlers';

describe('buildNpmInstallInvocation — install target (POSIX)', () => {
  const CS_ENTRY = '/tmp/codeam-node20/lib/node_modules/codeam-cli/dist/index.js';
  const CS_NODE = '/tmp/codeam-node20/bin/node';

  it('codespace layout: targets the running prefix and the sibling npm', () => {
    const inv = buildNpmInstallInvocation({
      entryScript: CS_ENTRY,
      execPath: CS_NODE,
      existsSync: (p: string) => p === '/tmp/codeam-node20/bin/npm',
      platform: 'linux',
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
      entryScript: path.posix.join(home, 'lib/node_modules/codeam-cli/dist/index.js'),
      execPath: path.posix.join(home, 'bin/node'),
      existsSync: (p: string) => p === path.posix.join(home, 'bin/npm'),
      platform: 'linux',
    });
    expect(inv.command).toBe(path.posix.join(home, 'bin/npm'));
    expect(inv.args).toContain('--prefix');
    expect(inv.args).toContain(home);
  });

  it('falls back to bare npm when no sibling npm exists', () => {
    const inv = buildNpmInstallInvocation({
      entryScript: CS_ENTRY,
      execPath: CS_NODE,
      existsSync: () => false,
      platform: 'linux',
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
      platform: 'linux',
    });
    expect(inv.command).toBe('npm');
    expect(inv.args).toEqual(['install', '-g', 'codeam-cli@latest']);
  });
});

// Windows-native expectations — the behavior a real Windows CLI user gets.
// buildNpmInstallInvocation derives the sibling npm name + path semantics from
// the injected `platform` (path.win32), so these now run on EVERY OS, not just
// the windows-latest matrix leg. What they pin:
//   - Windows global npm layouts have NO `lib/` segment, so the POSIX
//     `/lib/node_modules/codeam-cli/` marker never matches and no `--prefix`
//     is passed (correct: the `npm.cmd` sibling's own global prefix already
//     targets the install the daemon runs from).
//   - The sibling probe looks for `npm.cmd` (not `npm`) next to node.exe.
describe('buildNpmInstallInvocation — win32-native behavior', () => {
  it('standard Windows global layout: sibling npm.cmd, no --prefix', () => {
    const nodeDir = 'C:\\Program Files\\nodejs';
    const inv = buildNpmInstallInvocation({
      entryScript:
        'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\codeam-cli\\dist\\index.js',
      execPath: path.win32.join(nodeDir, 'node.exe'),
      existsSync: (p: string) => p === path.win32.join(nodeDir, 'npm.cmd'),
      platform: 'win32',
    });
    expect(inv.command).toBe(path.win32.join(nodeDir, 'npm.cmd'));
    expect(inv.args).toEqual(['install', '-g', 'codeam-cli@latest']);
  });

  it('nvm-windows layout: npm.cmd sibling of the running node version, no --prefix', () => {
    const versionDir = 'C:\\Users\\u\\AppData\\Roaming\\nvm\\v20.11.0';
    const inv = buildNpmInstallInvocation({
      entryScript: path.win32.join(versionDir, 'node_modules\\codeam-cli\\dist\\index.js'),
      execPath: path.win32.join(versionDir, 'node.exe'),
      existsSync: (p: string) => p === path.win32.join(versionDir, 'npm.cmd'),
      platform: 'win32',
    });
    expect(inv.command).toBe(path.win32.join(versionDir, 'npm.cmd'));
    expect(inv.args).toEqual(['install', '-g', 'codeam-cli@latest']);
  });

  it('no npm.cmd sibling: falls back to bare npm', () => {
    const inv = buildNpmInstallInvocation({
      entryScript:
        'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\codeam-cli\\dist\\index.js',
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      existsSync: () => false,
      platform: 'win32',
    });
    expect(inv.command).toBe('npm');
    expect(inv.args).toEqual(['install', '-g', 'codeam-cli@latest']);
  });
});

describe('buildNpmInstallInvocation — sudo escalation (self-hosted root-owned prefix)', () => {
  it('prepends sudo -n and passes the resolved npm + args through', () => {
    const inv = buildNpmInstallInvocation({
      entryScript: '/usr/lib/node_modules/codeam-cli/dist/index.js',
      execPath: '/usr/bin/node',
      existsSync: (p: string) => p === '/usr/bin/npm',
      sudo: true,
      platform: 'linux',
    });
    expect(inv.command).toBe('sudo');
    expect(inv.args).toEqual(['-n', '/usr/bin/npm', 'install', '-g', '--prefix', '/usr', 'codeam-cli@latest']);
  });
  it('without sudo runs npm directly (unchanged)', () => {
    const inv = buildNpmInstallInvocation({
      entryScript: '/usr/lib/node_modules/codeam-cli/dist/index.js',
      execPath: '/usr/bin/node',
      existsSync: (p: string) => p === '/usr/bin/npm',
      platform: 'linux',
    });
    expect(inv.command).toBe('/usr/bin/npm');
    expect(inv.args[0]).toBe('install');
  });
});

describe('isPermissionError', () => {
  it('matches EACCES / permission denied variants', () => {
    expect(isPermissionError('npm ERR! Error: EACCES: permission denied')).toBe(true);
    expect(isPermissionError('operation not permitted')).toBe(true);
  });
  it('does NOT match a transient network error', () => {
    expect(isPermissionError('ETIMEDOUT request to registry')).toBe(false);
  });
});
