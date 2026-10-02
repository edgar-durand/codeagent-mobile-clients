import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  bindSupervisedLifecycle,
  defaultRestartForUpdate,
  needsSelfRelaunch,
  READY_MESSAGE,
  SUPERVISED_FLAG,
  superviseCurrent,
  writeHostAgentPidFile,
  type SuperviseDeps,
} from '../../../src/commands/host/host-launch';
import { runSelfUpdateWith } from '../../../src/commands/host/self-update';
import {
  launcherOf,
  isBad,
  pointerTarget,
  switchCurrent,
  versionOf,
} from '../../../src/lib/cli-versions';

// Versioned installs are POSIX-only by design (`versionedModeSupported`: no
// Windows host-agent ships, and directory symlinks there need junctions), so
// the tests that build real `current`/`previous` symlinks skip on win32 rather
// than exercising a code path production never takes there.
const posixOnly = process.platform === 'win32';

/**
 * Host-agent-only launch onto the versioned install (codeagent-siec, review
 * round 2). The first design redirected EVERY command and re-exec'd a stale
 * argv[1] on relaunch — a restart loop from the second release (P0).
 */

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-host-launch-'));
});

function fakeVersion(version: string): string {
  const dir = path.join(root, version);
  const pkg = path.join(dir, 'node_modules', 'codeam-cli');
  fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(pkg, 'package.json'),
    JSON.stringify({ name: 'codeam-cli', version, bin: { codeam: 'dist/index.js' } }),
  );
  fs.writeFileSync(path.join(pkg, 'dist', 'index.js'), `// ${version}\n`);
  // npm --prefix also creates node_modules/.bin/codeam -> ../codeam-cli/<bin>.
  fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
  fs.symlinkSync('../codeam-cli/dist/index.js', path.join(dir, 'node_modules', '.bin', 'codeam'));
  return fs.realpathSync(dir);
}

type FakeChild = EventEmitter & { kill: ReturnType<typeof vi.fn> };
const fakeChild = (): FakeChild => Object.assign(new EventEmitter(), { kill: vi.fn() });

function harness(ownVersion: string, over: Partial<SuperviseDeps> = {}) {
  const children: FakeChild[] = [];
  const spawn = vi.fn<SuperviseDeps['spawn']>(() => {
    const c = fakeChild();
    children.push(c);
    return c as never;
  });
  const exit = vi.fn();
  const reraise = vi.fn();
  const warn = vi.fn();
  let t = 0;
  const run = superviseCurrent({
    ownVersion,
    root,
    args: [],
    execPath: 'node',
    platform: 'linux',
    now: () => (t += 1_000),
    spawn,
    exit,
    reraise,
    warn,
    stdinIsTty: false,
    ...over,
  });
  return { run, spawn, children, exit, reraise, warn };
}

describe('superviseCurrent — the host-agent hops onto a newer current, once', () => {
  it('runs itself when there is no newer valid current (and on Windows, and when already supervised)', async () => {
    switchCurrent(root, fakeVersion('2.76.11'));
    await expect(harness('2.76.11').run).resolves.toBe('self');
    await expect(harness('2.76.10', { platform: 'win32' }).run).resolves.toBe('self');
    await expect(harness('2.76.10', { args: [SUPERVISED_FLAG] }).run).resolves.toBe('self');
  });

  it.skipIf(posixOnly)('spawns `node <current entry> host-agent --supervised` and respawns the new current after an update (exit 0)', async () => {
    const v11 = fakeVersion('2.76.11');
    switchCurrent(root, v11);
    const h = harness('2.76.10');
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    expect(h.spawn.mock.calls[0]![1]).toEqual([launcherOf(v11), 'host-agent', SUPERVISED_FLAG]);

    // The child self-updated to 2.76.12 and exited 0 to restart.
    const v12 = fakeVersion('2.76.12');
    switchCurrent(root, v12);
    h.children[0]!.emit('exit', 0, null);
    await vi.waitFor(() => expect(h.children).toHaveLength(2));
    expect(h.spawn.mock.calls[1]![1]![0]).toBe(launcherOf(v12));
  });

  it.skipIf(posixOnly)('ONE pre-ready exit retries the same release (transient boot outage); TWO mark it .bad and roll back', async () => {
    const v11 = fakeVersion('2.76.11');
    const v12 = fakeVersion('2.76.12');
    switchCurrent(root, v11);
    switchCurrent(root, v12);
    const h = harness('2.76.10');
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    h.children[0]!.emit('exit', 1, null); // never sent READY — strike 1

    await vi.waitFor(() => expect(h.children).toHaveLength(2));
    expect(isBad(v12)).toBe(false);
    expect(h.spawn.mock.calls[1]![1]![0]).toBe(launcherOf(v12)); // same release again

    h.children[1]!.emit('exit', 1, null); // strike 2
    await vi.waitFor(() => expect(h.children).toHaveLength(3));
    expect(isBad(v12)).toBe(true);
    expect(pointerTarget(root, 'current')).toBe(v11);
    expect(h.spawn.mock.calls[2]![1]![0]).toBe(launcherOf(v11));

    // v11 then comes up fine: READY clears its strikes.
    h.children[2]!.emit('message', READY_MESSAGE);
    expect(fs.existsSync(path.join(v11, '.prefail'))).toBe(false);
  });

  it.skipIf(posixOnly)('no oscillation: once both releases are bad the launcher runs itself, and a restart stays there', async () => {
    const v11 = fakeVersion('2.76.11');
    switchCurrent(root, v11);
    const h = harness('2.76.10');
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    h.children[0]!.emit('exit', 1, null);
    await vi.waitFor(() => expect(h.children).toHaveLength(2));
    h.children[1]!.emit('exit', 1, null);
    await expect(h.run).resolves.toBe('self');
    expect(isBad(v11)).toBe(true);
    await expect(harness('2.76.10').run).resolves.toBe('self');
  });

  it.skipIf(posixOnly)('identity rejection / not enrolled (exit 78) is EXPECTED: no .bad, no rollback, exit 78', async () => {
    const v11 = fakeVersion('2.76.11');
    switchCurrent(root, v11);
    const h = harness('2.76.10');
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    h.children[0]!.emit('exit', 78, null);
    await expect(h.run).resolves.toBe('supervised');
    expect(h.exit).toHaveBeenCalledWith(78);
    expect(isBad(v11)).toBe(false);
  });

  it.skipIf(posixOnly)('a crash AFTER ready is not a bad release: exit code passed through', async () => {
    const v11 = fakeVersion('2.76.11');
    switchCurrent(root, v11);
    const h = harness('2.76.10');
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    h.children[0]!.emit('message', READY_MESSAGE);
    h.children[0]!.emit('exit', 3, null);
    await expect(h.run).resolves.toBe('supervised');
    expect(h.exit).toHaveBeenCalledWith(3);
    expect(isBad(v11)).toBe(false);
  });

  it.skipIf(posixOnly)('a signal-killed child re-raises the same signal (exit code semantics kept)', async () => {
    switchCurrent(root, fakeVersion('2.76.11'));
    const h = harness('2.76.10');
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    h.children[0]!.emit('exit', null, 'SIGTERM');
    await expect(h.run).resolves.toBe('supervised');
    expect(h.reraise).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('restart after an update — no loop across two consecutive releases', () => {
  it.skipIf(posixOnly)('codespace (no supervisor): relaunches onto the CURRENT entry, never a stale argv[1]', () => {
    const v11 = fakeVersion('2.76.11');
    switchCurrent(root, v11);
    const relaunch = vi.fn();
    const exit = vi.fn();
    // Running 2.76.10 from an OLD versioned dir (argv[1]); 2.76.11 just became current.
    const stale = launcherOf(fakeVersion('2.76.10'))!;
    defaultRestartForUpdate('2.76.11', false, {
      needsRelaunch: true,
      root,
      ownVersion: '2.76.10',
      argv1: stale,
      relaunch,
      exit,
    });
    expect(relaunch.mock.calls[0]![0][1]).toBe(launcherOf(v11));
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('supervised: just exits 0 (the parent respawns current), never relaunches', () => {
    const relaunch = vi.fn();
    const exit = vi.fn();
    defaultRestartForUpdate('2.76.11', true, { needsRelaunch: true, relaunch, exit });
    expect(relaunch).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it.skipIf(posixOnly)('release 1 then release 2: the relaunched process IS current, so its startup check does not restart again', async () => {
    for (const v of ['2.76.11', '2.76.12']) {
      switchCurrent(root, fakeVersion(v));
      // The relaunched host-agent runs `current` → its own version == current.
      const res = await runSelfUpdateWith({
        run: vi.fn(async (_cmd: string, args: string[]) =>
          args[0] === 'view'
            ? { code: 0, stdout: `${v}\n`, stderr: '' }
            : { code: 1, stdout: '', stderr: '' },
        ),
        currentVersion: () => versionOf(pointerTarget(root, 'current')!),
        isRoot: () => false,
        versionsRoot: root,
        nodePath: 'node',
        platform: 'linux',
      });
      expect(res.status).toBe('current');
    }
  });
});

describe('local users are unaffected', () => {
  it('main() performs no version hop; only `host-agent` can (superviseCurrent lives in hostAgent)', () => {
    const src = (f: string) => fs.readFileSync(path.join(__dirname, '../../../src', f), 'utf8');
    const index = src('index.ts');
    expect(index).not.toMatch(/superviseCurrent|hostEntry|version-redirect|CODEAM_CLI_REDIRECTED/);
    const hostAgent = src('commands/host-agent.ts');
    expect(hostAgent).toMatch(/export async function hostAgent[\s\S]*superviseCurrent\(\{ args \}\)/);
  });
});

describe('supervised child lifecycle', () => {
  it('exits when the hop parent dies (IPC disconnect) — no orphan host-agent', () => {
    const proc = new EventEmitter();
    const onOrphaned = vi.fn();
    bindSupervisedLifecycle(proc as never, onOrphaned);
    proc.emit('disconnect');
    expect(onOrphaned).toHaveBeenCalledTimes(1);
  });

  it('host-agent wires it only when --supervised', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../src/commands/host-agent.ts'), 'utf8');
    expect(src).toMatch(/if \(args\.includes\(SUPERVISED_FLAG\)\) bindSupervisedLifecycle\(process, shutdown\)/);
  });
});

describe('host-agent pid file (backend liveness check)', () => {
  it('writes the pid to ~/.codeam/host-agent.pid', () => {
    const file = path.join(root, '.codeam', 'host-agent.pid');
    writeHostAgentPidFile(file, 4242);
    expect(fs.readFileSync(file, 'utf8')).toBe('4242');
  });
});

describe('needsSelfRelaunch', () => {
  const tini = ['/usr/bin/tini', '--', 'codeam', 'host-agent'];
  it.each([
    ['Box: pid 1 is our tini entrypoint → exit, container restarts us', {}, 7, 1, tini, false],
    ['container with an unrelated pid 1 (sleep) → self-relaunch', {}, 7, 1, ['sleep', 'infinity'], true],
    ['container with an unrelated pid 1 (bash) → self-relaunch', {}, 7, 1, ['/bin/bash'], true],
    ['wrapper codespace (setsid, re-parented to 1) → self-relaunch', { CODESPACES: 'true' }, 4242, 1, ['/sbin/docker-init', '--', '/bin/sh'], true],
    ['codespace ssh env WITHOUT CODESPACES → still self-relaunch', {}, 4242, 1, ['/bin/sh', '-c', 'sleep infinity'], true],
    ['tini but not our entrypoint → self-relaunch', {}, 7, 1, ['/usr/bin/tini', '--', 'node', 'server.js'], true],
    ['not a direct child of pid 1 → self-relaunch', {}, 4242, 77, tini, true],
    ['systemd unit → exit', { INVOCATION_ID: 'x' }, 4242, 1, [], false],
    ['pid 1 itself (no init) → exit', {}, 1, 0, [], false],
  ])('%s', (_l, env, pid, ppid, pid1, expected) => {
    expect(needsSelfRelaunch(env, pid, { ppid, pid1Cmdline: () => pid1 })).toBe(expected);
  });
});
