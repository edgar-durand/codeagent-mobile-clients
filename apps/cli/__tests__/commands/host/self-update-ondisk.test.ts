import { describe, it, expect, vi } from 'vitest';
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
    ...over,
  };
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

  it('still installs when the disk matches what is already running', async () => {
    const run = vi.fn(async (cmd: string, args: string[]) => {
      if (args[0] === 'ls') return { code: 0, stdout: lsJson('2.65.16'), stderr: '' };
      if (args[0] === 'view') return { code: 0, stdout: '2.66.0\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });

    const res = await runSelfUpdateWith(deps({ run, isRoot: () => true }));

    expect(res.status).toBe('updated');
    const attempted = run.mock.calls.map(([cmd, args]) => `${cmd} ${args.join(' ')}`);
    expect(attempted.some((c) => c.includes('install -g'))).toBe(true);
  });

  it('falls through to the registry path when the on-disk version is unreadable', async () => {
    const run = vi.fn(async (cmd: string, args: string[]) => {
      if (args[0] === 'ls') return { code: 1, stdout: 'not json', stderr: 'boom' };
      if (args[0] === 'view') return { code: 0, stdout: '2.66.0\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });

    const res = await runSelfUpdateWith(deps({ run, isRoot: () => true }));

    expect(res.status).toBe('updated');
  });
});

describe('runSelfUpdate — sudo escalation', () => {
  it('does not shell out to sudo when passwordless sudo is unavailable', async () => {
    const run = vi.fn(async (cmd: string, args: string[]) => {
      if (args[0] === 'ls') return { code: 0, stdout: lsJson('2.65.16'), stderr: '' };
      if (args[0] === 'view') return { code: 0, stdout: '2.66.0\n', stderr: '' };
      if (cmd === 'npm' && args[0] === 'install') {
        return { code: 1, stdout: '', stderr: 'npm ERR! code EACCES' };
      }
      // `sudo -n true` — the pre-flight. Not in sudoers → non-zero.
      if (cmd === 'sudo') return { code: 1, stdout: '', stderr: 'user NOT in sudoers' };
      return { code: 0, stdout: '', stderr: '' };
    });

    const res = await runSelfUpdateWith(deps({ run }));

    expect(res.status).toBe('skipped');
    // A TTY-less systemd unit can never answer a password prompt, so the real
    // `sudo npm install` must never be attempted — it can only burn its full
    // 180 s timeout and log a failure whose cause is already known.
    const sudoInstalls = run.mock.calls.filter(
      ([cmd, args]) => cmd === 'sudo' && args.includes('install'),
    );
    expect(sudoInstalls).toHaveLength(0);
  });

  it('still escalates when passwordless sudo IS available', async () => {
    const run = vi.fn(async (cmd: string, args: string[]) => {
      if (args[0] === 'ls') return { code: 0, stdout: lsJson('2.65.16'), stderr: '' };
      if (args[0] === 'view') return { code: 0, stdout: '2.66.0\n', stderr: '' };
      if (cmd === 'npm' && args[0] === 'install') {
        return { code: 1, stdout: '', stderr: 'npm ERR! code EACCES' };
      }
      return { code: 0, stdout: '', stderr: '' }; // `sudo -n true` + sudo install
    });

    const res = await runSelfUpdateWith(deps({ run }));

    expect(res.status).toBe('updated');
    const sudoInstalls = run.mock.calls.filter(
      ([cmd, args]) => cmd === 'sudo' && args.includes('install'),
    );
    expect(sudoInstalls).toHaveLength(1);
  });

  it('never escalates as root — there is nothing to escalate to', async () => {
    const run = vi.fn(async (cmd: string, args: string[]) => {
      if (args[0] === 'ls') return { code: 0, stdout: lsJson('2.65.16'), stderr: '' };
      if (args[0] === 'view') return { code: 0, stdout: '2.66.0\n', stderr: '' };
      if (cmd === 'npm' && args[0] === 'install') {
        return { code: 1, stdout: '', stderr: 'npm ERR! code EACCES' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    const res = await runSelfUpdateWith(deps({ run, isRoot: () => true }));

    expect(res.status).toBe('skipped');
    expect(run.mock.calls.filter(([cmd]) => cmd === 'sudo')).toHaveLength(0);
  });
});
