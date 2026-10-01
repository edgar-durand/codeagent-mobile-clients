import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runSelfUpdateWith, type SelfUpdateDeps } from '../../../src/commands/host/self-update';

/**
 * The self-update assumed it was the only thing that could update the package.
 *
 * WHY THIS EXISTS — codeagent-53em follow-up, fleet-1 (2026-08-24).
 *
 * `fleet-1` runs FOUR host-agents off ONE npm global prefix (`/usr`):
 * `codeam-host-agent` as root, plus `codeam-demo`, `codeam-edgar` and
 * `codeam-fleet-dev` as unprivileged users. The root one installs new versions
 * fine; the other three cannot write `/usr/lib/node_modules` and are not in
 * sudoers, so every hourly tick logged
 *
 *   self-update: 2.65.16 → 2.66.0 available — installing
 *   self-update: install hit EACCES — retrying with sudo
 *   self-update: install exited 1 — staying on 2.65.16
 *
 * 318 times on the demo box alone (122 on fleet-dev, 24 on edgar) — while
 * `/usr/bin/codeam --version` ALREADY said 2.66.0. The root service had
 * installed it hours earlier. Nothing needed installing; the processes just
 * needed to restart. Instead the shared demo session — our GitHub-OAuth-free
 * activation path — sat pinned on 2.65.16 for days, unreachable by any CLI fix.
 *
 * So the check has to ask the cheap local question FIRST — "is the version on
 * disk already newer than the one I am running?" — before asking the registry
 * and trying to install. That is a `npm ls -g` away, needs no network, no
 * privileges, and no sudoers entry.
 */
function deps(over: Partial<SelfUpdateDeps> = {}): SelfUpdateDeps {
  return {
    run: vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: '' }),
    currentVersion: () => '2.65.16',
    isRoot: () => false,
    // Never the real ~/.codeam/cli.
    versionsRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-cli-versions-')),
    nodePath: 'node',
    ...over,
  };
}

/**
 * Fake npm/node for the side-by-side install: `npm install --prefix <dir>
 * codeam-cli@<v>` writes a runnable package there; `node <entry> --version`
 * answers with the version it finds.
 */
function fakeInstallRun(viewVersion: string, lsVersion: string) {
  return vi.fn(async (cmd: string, args: string[]) => {
    if (args[0] === 'ls') return { code: 0, stdout: lsJson(lsVersion), stderr: '' };
    if (args[0] === 'view') return { code: 0, stdout: `${viewVersion}\n`, stderr: '' };
    if (cmd === 'npm' && args[0] === 'install') {
      const prefix = args[args.indexOf('--prefix') + 1]!;
      const version = args[args.length - 1]!.split('@').pop()!;
      const pkg = path.join(prefix, 'node_modules', 'codeam-cli');
      fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
      fs.writeFileSync(
        path.join(pkg, 'package.json'),
        JSON.stringify({ name: 'codeam-cli', version, bin: { codeam: 'dist/index.js' } }),
      );
      fs.writeFileSync(path.join(pkg, 'dist', 'index.js'), `// ${version}\n`);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[1] === '--version') {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(path.dirname(path.dirname(args[0]!)), 'package.json'), 'utf8'),
      ) as { version: string };
      return { code: 0, stdout: `codeam-cli ${pkg.version}\n`, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  });
}

/** `npm ls -g --depth=0 --json codeam-cli` output, verbatim shape. */
const lsJson = (version: string): string =>
  JSON.stringify({ name: 'lib', dependencies: { 'codeam-cli': { version } } });

describe('runSelfUpdate — the version already on disk', () => {
  it('restarts onto the newer on-disk build without installing anything', async () => {
    const run = vi.fn(async (cmd: string, args: string[]) => {
      if (args[0] === 'ls') return { code: 0, stdout: lsJson('2.66.0'), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });

    const res = await runSelfUpdateWith(deps({ run }));

    expect(res).toEqual({ status: 'updated', version: '2.66.0' });
    // THE POINT: no install is attempted. Attempting it is what burned 180 s an
    // hour and filled the journal with a failure that was never the problem.
    const attempted = run.mock.calls.map(([cmd, args]) => `${cmd} ${args.join(' ')}`);
    expect(attempted.some((c) => c.includes('install'))).toBe(false);
    // And no registry round-trip either — the local answer settled it.
    expect(attempted.some((c) => c.includes('view'))).toBe(false);
  });

  it('still installs (side-by-side, never `-g`) when the disk matches what is already running', async () => {
    const run = fakeInstallRun('2.66.0', '2.65.16');

    const res = await runSelfUpdateWith(deps({ run }));

    expect(res).toEqual({ status: 'updated', version: '2.66.0' });
    const attempted = run.mock.calls.map(([cmd, args]) => `${cmd} ${args.join(' ')}`);
    expect(attempted.some((c) => c.includes('install --prefix'))).toBe(true);
    expect(attempted.some((c) => c.includes('install -g'))).toBe(false);
  });

  it('falls through to the registry path when the on-disk version is unreadable', async () => {
    const run = fakeInstallRun('2.66.0', '2.65.16');
    run.mockImplementationOnce(async () => ({ code: 1, stdout: 'not json', stderr: 'boom' }));

    const res = await runSelfUpdateWith(deps({ run }));

    expect(res.status).toBe('updated');
  });
});

// The side-by-side install (codeagent-siec) goes into the per-user
// ~/.codeam/cli — always writable — so the old global-prefix EACCES → sudo
// escalation (and its 318-failures-a-day journal noise on fleet-1) is gone.
describe('runSelfUpdate — no global prefix, no sudo', () => {
  it('never shells out to sudo, root or not', async () => {
    for (const isRoot of [true, false]) {
      const run = fakeInstallRun('2.66.0', '2.65.16');
      const res = await runSelfUpdateWith(deps({ run, isRoot: () => isRoot }));
      expect(res.status).toBe('updated');
      expect(run.mock.calls.filter(([cmd]) => cmd === 'sudo')).toHaveLength(0);
    }
  });
});

describe('runSelfUpdate — Windows keeps the legacy global install', () => {
  it('uses `npm install -g` and never creates a versioned directory on win32', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-cli-versions-'));
    const run = fakeInstallRun('2.66.0', '2.65.16');
    const res = await runSelfUpdateWith(deps({ run, platform: 'win32', versionsRoot: root }));
    expect(res).toEqual({ status: 'updated', version: '2.66.0' });
    const attempted = run.mock.calls.map(([cmd, args]) => `${cmd} ${args.join(' ')}`);
    expect(attempted.some((c) => c.includes('install -g'))).toBe(true);
    expect(attempted.some((c) => c.includes('--prefix'))).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
