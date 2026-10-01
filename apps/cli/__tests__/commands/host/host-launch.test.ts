import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  defaultRestartForUpdate,
  READY_MESSAGE,
  SUPERVISED_FLAG,
  superviseCurrent,
  type SuperviseDeps,
} from '../../../src/commands/host/host-launch';
import { runSelfUpdateWith } from '../../../src/commands/host/self-update';
import {
  entryOf,
  isBad,
  pointerTarget,
  switchCurrent,
  versionOf,
} from '../../../src/lib/cli-versions';

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

  it('spawns `node <current entry> host-agent --supervised` and respawns the new current after an update (exit 0)', async () => {
    const v11 = fakeVersion('2.76.11');
    switchCurrent(root, v11);
    const h = harness('2.76.10');
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    expect(h.spawn.mock.calls[0]![1]).toEqual([entryOf(v11), 'host-agent', SUPERVISED_FLAG]);

    // The child self-updated to 2.76.12 and exited 0 to restart.
    const v12 = fakeVersion('2.76.12');
    switchCurrent(root, v12);
    h.children[0]!.emit('exit', 0, null);
    await vi.waitFor(() => expect(h.children).toHaveLength(2));
    expect(h.spawn.mock.calls[1]![1]![0]).toBe(entryOf(v12));
  });

  it('a release that dies BEFORE ready is marked .bad and rolled back — no oscillation', async () => {
    const v11 = fakeVersion('2.76.11');
    const v12 = fakeVersion('2.76.12');
    switchCurrent(root, v11);
    switchCurrent(root, v12);
    const h = harness('2.76.10');
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    h.children[0]!.emit('exit', 1, null); // never sent READY

    await vi.waitFor(() => expect(h.children).toHaveLength(2));
    expect(isBad(v12)).toBe(true);
    expect(pointerTarget(root, 'current')).toBe(v11);
    expect(h.spawn.mock.calls[1]![1]![0]).toBe(entryOf(v11));

    // v11 also dies before ready → marked bad too; nothing left → the launcher runs itself.
    h.children[1]!.emit('exit', 1, null);
    await expect(h.run).resolves.toBe('self');
    expect(isBad(v11)).toBe(true);
    // A later start does NOT go back to a bad release.
    await expect(harness('2.76.10').run).resolves.toBe('self');
  });

  it('identity rejection / not enrolled (exit 78) is EXPECTED: no .bad, no rollback, exit 78', async () => {
    const v11 = fakeVersion('2.76.11');
    switchCurrent(root, v11);
    const h = harness('2.76.10');
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    h.children[0]!.emit('exit', 78, null);
    await expect(h.run).resolves.toBe('supervised');
    expect(h.exit).toHaveBeenCalledWith(78);
    expect(isBad(v11)).toBe(false);
  });

  it('a crash AFTER ready is not a bad release: exit code passed through', async () => {
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

  it('a signal-killed child re-raises the same signal (exit code semantics kept)', async () => {
    switchCurrent(root, fakeVersion('2.76.11'));
    const h = harness('2.76.10');
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    h.children[0]!.emit('exit', null, 'SIGTERM');
    await expect(h.run).resolves.toBe('supervised');
    expect(h.reraise).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('restart after an update — no loop across two consecutive releases', () => {
  it('codespace (no supervisor): relaunches onto the CURRENT entry, never a stale argv[1]', () => {
    const v11 = fakeVersion('2.76.11');
    switchCurrent(root, v11);
    const relaunch = vi.fn();
    const exit = vi.fn();
    // Running 2.76.10 from an OLD versioned dir (argv[1]); 2.76.11 just became current.
    const stale = entryOf(fakeVersion('2.76.10'))!;
    defaultRestartForUpdate('2.76.11', false, {
      needsRelaunch: true,
      root,
      ownVersion: '2.76.10',
      argv1: stale,
      relaunch,
      exit,
    });
    expect(relaunch.mock.calls[0]![0][1]).toBe(entryOf(v11));
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('supervised: just exits 0 (the parent respawns current), never relaunches', () => {
    const relaunch = vi.fn();
    const exit = vi.fn();
    defaultRestartForUpdate('2.76.11', true, { needsRelaunch: true, relaunch, exit });
    expect(relaunch).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('release 1 then release 2: the relaunched process IS current, so its startup check does not restart again', async () => {
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
