import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  entryOf,
  gcVersions,
  pointerTarget,
  redirectTarget,
  rollbackCurrent,
  switchCurrent,
  versionOf,
} from '../../src/lib/cli-versions';
import { installVersioned, type SelfUpdateDeps } from '../../src/commands/host/self-update';
import {
  maybeRedirectToVersioned,
  CRASH_WINDOW_MS,
  type RedirectDeps,
} from '../../src/lib/version-redirect';

/**
 * Side-by-side codeam-cli installs (codeagent-siec). The old self-update ran
 * `npm install -g` over the very tree the running supervisor spawns session
 * children from; a child spawned mid-install could load a half-written CLI.
 */

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-cli-versions-'));
});

/** Lay down a complete, runnable package for `version` under root/<version>. */
function fakeVersion(version: string): string {
  const dir = path.join(root, version);
  const pkg = path.join(dir, 'node_modules', 'codeam-cli');
  fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(pkg, 'package.json'),
    JSON.stringify({ name: 'codeam-cli', version, bin: { codeam: 'dist/index.js' } }),
  );
  fs.writeFileSync(path.join(pkg, 'dist', 'index.js'), `// codeam-cli ${version} — complete\n`);
  return fs.realpathSync(dir);
}

type Run = SelfUpdateDeps['run'];

/** npm/node fake: `install --prefix` writes the package (optionally after a gate). */
function fakeRun(opts: { gate?: Promise<void>; installCode?: number; verifyOut?: string } = {}) {
  return vi.fn<Run>(async (cmd, args) => {
    if (cmd === 'npm' && args[0] === 'install') {
      const prefix = args[args.indexOf('--prefix') + 1]!;
      const version = args[args.length - 1]!.split('@').pop()!;
      const pkg = path.join(prefix, 'node_modules', 'codeam-cli');
      // Half-written state first — exactly what a racing spawn used to see.
      fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"codeam-cli"');
      await opts.gate;
      if (opts.installCode && opts.installCode !== 0) {
        return { code: opts.installCode, stdout: '', stderr: 'npm ERR! network' };
      }
      fs.writeFileSync(
        path.join(pkg, 'package.json'),
        JSON.stringify({ name: 'codeam-cli', version, bin: { codeam: 'dist/index.js' } }),
      );
      fs.writeFileSync(path.join(pkg, 'dist', 'index.js'), `// codeam-cli ${version}\n`);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[1] === '--version') {
      if (opts.verifyOut !== undefined) return { code: 0, stdout: opts.verifyOut, stderr: '' };
      const v = versionOf(path.resolve(path.dirname(args[0]!), '..', '..', '..'));
      return { code: 0, stdout: `codeam-cli ${v}\n`, stderr: '' };
    }
    return { code: 1, stdout: '', stderr: '' };
  });
}

function deps(run: Run, runningEntry?: string): SelfUpdateDeps {
  return {
    run,
    currentVersion: () => '2.76.10',
    isRoot: () => false,
    versionsRoot: root,
    runningEntry,
    nodePath: 'node',
  };
}

describe('installVersioned — install, verify, atomic switch', () => {
  it('a spawn DURING the install still resolves the old, COMPLETE version', async () => {
    const old = fakeVersion('2.76.10');
    switchCurrent(root, old);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));

    const pending = installVersioned(deps(fakeRun({ gate })), root, '2.76.11', '2.76.10');
    await vi.waitFor(() => expect(fs.existsSync(path.join(root, '2.76.11'))).toBe(true));

    // What a concurrent session spawn resolves right now:
    const cur = pointerTarget(root, 'current')!;
    expect(versionOf(cur)).toBe('2.76.10');
    expect(fs.readFileSync(entryOf(cur)!, 'utf8')).toContain('complete');
    // …and the half-written new dir is never what `current` or a redirect points at.
    expect(redirectTarget(root, '2.76.10')).toBeNull();

    release();
    await expect(pending).resolves.toEqual({ status: 'updated', version: '2.76.11' });
    expect(versionOf(pointerTarget(root, 'current')!)).toBe('2.76.11');
    expect(pointerTarget(root, 'previous')).toBe(old);
    // The old version's files were never touched.
    expect(fs.readFileSync(entryOf(old)!, 'utf8')).toContain('complete');
  });

  it('a FAILED install leaves current untouched and removes the partial dir', async () => {
    const old = fakeVersion('2.76.10');
    switchCurrent(root, old);

    const res = await installVersioned(deps(fakeRun({ installCode: 1 })), root, '2.76.11', '2.76.10');

    expect(res.status).toBe('skipped');
    expect(pointerTarget(root, 'current')).toBe(old);
    expect(fs.existsSync(path.join(root, '2.76.11'))).toBe(false);
  });

  it('a FAILED verification (binary reports another version) never becomes current', async () => {
    const old = fakeVersion('2.76.10');
    switchCurrent(root, old);

    const res = await installVersioned(
      deps(fakeRun({ verifyOut: 'codeam-cli 2.76.10\n' })),
      root,
      '2.76.11',
      '2.76.10',
    );

    expect(res.status).toBe('skipped');
    expect(pointerTarget(root, 'current')).toBe(old);
    expect(fs.existsSync(path.join(root, '2.76.11'))).toBe(false);
  });

  it('works from scratch (no current yet: Box / codespace running the image global)', async () => {
    const res = await installVersioned(deps(fakeRun()), root, '2.76.11', '2.76.10');
    expect(res).toEqual({ status: 'updated', version: '2.76.11' });
    expect(versionOf(pointerTarget(root, 'current')!)).toBe('2.76.11');
    expect(pointerTarget(root, 'previous')).toBeNull();
  });
});

describe('rollbackCurrent', () => {
  it('swaps current and previous atomically', () => {
    const a = fakeVersion('2.76.10');
    const b = fakeVersion('2.76.11');
    switchCurrent(root, a);
    switchCurrent(root, b);

    expect(rollbackCurrent(root)).toBe('2.76.10');
    expect(pointerTarget(root, 'current')).toBe(a);
    expect(pointerTarget(root, 'previous')).toBe(b);
  });

  it('refuses when there is no runnable previous', () => {
    switchCurrent(root, fakeVersion('2.76.11'));
    expect(rollbackCurrent(root)).toBeNull();
    expect(versionOf(pointerTarget(root, 'current')!)).toBe('2.76.11');
  });
});

describe('gcVersions', () => {
  it('keeps current, previous and the RUNNING version; removes the rest + stale staging', () => {
    const running = fakeVersion('2.76.8');
    fakeVersion('2.76.9');
    const prev = fakeVersion('2.76.10');
    const cur = fakeVersion('2.76.11');
    switchCurrent(root, prev);
    switchCurrent(root, cur);
    fs.mkdirSync(path.join(root, '.staging-2.76.7-99999-1'));

    const removed = gcVersions(root, entryOf(running)!);

    expect(removed.sort()).toEqual(['.staging-2.76.7-99999-1', '2.76.9']);
    for (const kept of [running, prev, cur]) expect(fs.existsSync(kept)).toBe(true);
  });
});

describe('maybeRedirectToVersioned — any entry point lands on current', () => {
  type FakeChild = EventEmitter & { kill: ReturnType<typeof vi.fn> };
  function fakeChild(): FakeChild {
    return Object.assign(new EventEmitter(), { kill: vi.fn() });
  }

  it('runs a strictly newer current instead of itself, with the child exit code', async () => {
    switchCurrent(root, fakeVersion('2.76.11'));
    const child = fakeChild();
    const spawn = vi.fn<RedirectDeps['spawn']>(() => child as never);
    const exit = vi.fn();

    const p = maybeRedirectToVersioned({
      ownVersion: '2.76.10',
      root,
      argv: ['node', '/usr/local/bin/codeam', 'host-agent'],
      env: {},
      spawn,
      exit,
      now: () => 0,
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    child.emit('exit', 0, null);

    await expect(p).resolves.toBe('redirected');
    const [, args, env] = spawn.mock.calls[0]!;
    expect(args[0]).toBe(entryOf(path.join(root, '2.76.11')));
    expect(args.slice(1)).toEqual(['host-agent']);
    expect(env.CODEAM_CLI_REDIRECTED).toBe('1');
    expect(exit).toHaveBeenCalledWith(0);
  });

  it.each([
    ['equal', '2.76.11'],
    ['older current than us (a newer global install wins)', '2.76.12'],
  ])('runs itself when current is %s', async (_l, own) => {
    switchCurrent(root, fakeVersion('2.76.11'));
    const spawn = vi.fn<RedirectDeps['spawn']>();
    await expect(
      maybeRedirectToVersioned({ ownVersion: own, root, argv: ['n', 'c'], env: {}, spawn }),
    ).resolves.toBe('self');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('never redirects twice (loop guard)', async () => {
    switchCurrent(root, fakeVersion('2.76.11'));
    const spawn = vi.fn<RedirectDeps['spawn']>();
    await expect(
      maybeRedirectToVersioned({
        ownVersion: '2.76.10',
        root,
        argv: ['n', 'c'],
        env: { CODEAM_CLI_REDIRECTED: '1' },
        spawn,
      }),
    ).resolves.toBe('self');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('a host-agent that crashes right after start is rolled back ONCE, then the launcher runs itself', async () => {
    const good = fakeVersion('2.76.11');
    const bad = fakeVersion('2.76.12');
    switchCurrent(root, good);
    switchCurrent(root, bad);
    const children: FakeChild[] = [];
    const spawn = vi.fn<RedirectDeps['spawn']>(() => {
      const c = fakeChild();
      children.push(c);
      return c as never;
    });
    const exit = vi.fn();
    const warn = vi.fn();

    const p = maybeRedirectToVersioned({
      ownVersion: '2.76.10',
      root,
      argv: ['n', 'c', 'host-agent'],
      env: {},
      spawn,
      exit,
      warn,
      now: () => 1_000, // every exit lands inside the crash window
    });
    // 2.76.12 crashes → rolled back to 2.76.11.
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0]!.emit('exit', 1, null);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    expect(pointerTarget(root, 'current')).toBe(good);
    // 2.76.11 crashes too → no second rollback, run the launcher's own version.
    children[1]!.emit('exit', 1, null);

    await expect(p).resolves.toBe('self');
    expect(exit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(CRASH_WINDOW_MS).toBeGreaterThan(0);
  });
});
