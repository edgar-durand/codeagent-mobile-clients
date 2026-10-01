import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  acquireInstallLock,
  BAD_MARKER_TTL_MS,
  entryOf,
  launcherOf,
  gcVersions,
  hostEntry,
  isBad,
  markBad,
  pointerTarget,
  rollbackCurrent,
  switchCurrent,
  validCurrent,
  versionOf,
} from '../../src/lib/cli-versions';
import { installVersioned, type SelfUpdateDeps } from '../../src/commands/host/self-update';

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
  // npm --prefix also creates node_modules/.bin/codeam -> ../codeam-cli/<bin>.
  fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
  fs.symlinkSync('../codeam-cli/dist/index.js', path.join(dir, 'node_modules', '.bin', 'codeam'));
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
    // …and the half-written new dir is never what a session would be spawned from.
    expect(hostEntry(root, '2.76.10', '/global/codeam', 'linux')).toBe(launcherOf(old));

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
  it('keeps current, previous, the 3 newest and any version with a LIVE pid; removes the rest', () => {
    const live = fakeVersion('2.76.5'); // an old version a session still runs from
    fakeVersion('2.76.6');
    const prev = fakeVersion('2.76.7');
    fakeVersion('2.76.8');
    fakeVersion('2.76.9');
    const cur = fakeVersion('2.76.10');
    switchCurrent(root, prev);
    switchCurrent(root, cur);
    fs.mkdirSync(path.join(live, '.pids'), { recursive: true });
    fs.writeFileSync(path.join(live, '.pids', String(process.pid)), ''); // alive
    const dead = fakeVersion('2.76.4');
    fs.mkdirSync(path.join(dead, '.pids'), { recursive: true });
    fs.writeFileSync(path.join(dead, '.pids', '999999'), ''); // stale pid file

    const removed = gcVersions(root);

    expect(removed.sort()).toEqual(['2.76.4', '2.76.6']);
    for (const kept of [live, prev, cur]) expect(fs.existsSync(kept)).toBe(true);
    // 3 newest: 2.76.10, 2.76.9, 2.76.8
    expect(fs.existsSync(path.join(root, '2.76.8'))).toBe(true);
  });
});

describe('bad releases', () => {
  it('a release marked .bad is never resolved as current, nor reinstalled', async () => {
    const good = fakeVersion('2.76.10');
    const bad = fakeVersion('2.76.11');
    switchCurrent(root, good);
    switchCurrent(root, bad);
    markBad(bad, 'crashed before ready');

    expect(validCurrent(root)).toBeNull();
    expect(hostEntry(root, '2.76.10', '/global/codeam', 'linux')).toBe('/global/codeam');

    const run = fakeRun();
    const res = await installVersioned(deps(run), root, '2.76.11', '2.76.10');
    expect(res.status).toBe('skipped');
    expect(run).not.toHaveBeenCalled();
    expect(isBad(bad)).toBe(true);
  });

  it('rollback never targets a bad previous', () => {
    const a = fakeVersion('2.76.10');
    const b = fakeVersion('2.76.11');
    switchCurrent(root, a);
    switchCurrent(root, b);
    markBad(a, 'x');
    expect(rollbackCurrent(root)).toBeNull();
  });
});

describe('install lock (O_EXCL)', () => {
  it('a second installer cannot take the lock while the first holds it', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const first = fakeRun({ gate });
    const second = fakeRun();

    const p1 = installVersioned(deps(first), root, '2.76.11', '2.76.10');
    await vi.waitFor(() => expect(first).toHaveBeenCalled());
    const r2 = await installVersioned(deps(second), root, '2.76.11', '2.76.10');

    expect(r2.status).toBe('skipped');
    expect(second).not.toHaveBeenCalled();
    release();
    await expect(p1).resolves.toEqual({ status: 'updated', version: '2.76.11' });
    // released → available again
    const again = acquireInstallLock(root);
    expect(again).not.toBeNull();
    again?.();
  });

  it('takes over a lock whose owner is dead', () => {
    fs.writeFileSync(path.join(root, '.install.lock'), '999999');
    const r = acquireInstallLock(root);
    expect(r).not.toBeNull();
    r?.();
  });
});

describe('hostEntry — what the host-agent spawns sessions from / relaunches onto', () => {
  it('current when it is at least our version', () => {
    const cur = fakeVersion('2.76.11');
    switchCurrent(root, cur);
    expect(hostEntry(root, '2.76.10', '/g', 'linux')).toBe(launcherOf(cur));
    expect(hostEntry(root, '2.76.11', '/g', 'linux')).toBe(launcherOf(cur));
  });

  it('never downgrades: a newer running binary keeps its own entry', () => {
    switchCurrent(root, fakeVersion('2.76.11'));
    expect(hostEntry(root, '2.76.12', '/g', 'linux')).toBe('/g');
  });

  it('Windows keeps the legacy behaviour (no versioned mode)', () => {
    switchCurrent(root, fakeVersion('2.76.11'));
    expect(hostEntry(root, '2.76.10', 'C:\\codeam', 'win32')).toBe('C:\\codeam');
  });
});

describe('launcherOf — the backend can still recognise the host-agent', () => {
  it('spawns via node_modules/.bin/codeam so the cmdline reads ".../codeam host-agent"', () => {
    const v = fakeVersion('2.76.11');
    const launcher = launcherOf(v)!;
    expect(launcher.endsWith(path.join('node_modules', '.bin', 'codeam'))).toBe(true);
    // what `pgrep -f 'codeam host-agent'` sees for `node <launcher> host-agent`:
    expect(`node ${launcher} host-agent --supervised`).toMatch(/codeam host-agent/);
  });

  it('falls back to the package entry when .bin/codeam is missing', () => {
    const v = fakeVersion('2.76.11');
    fs.rmSync(path.join(v, 'node_modules', '.bin', 'codeam'));
    expect(launcherOf(v)).toBe(entryOf(v));
  });
});

describe('.bad markers expire', () => {
  it('a marker older than 24 h no longer blocks the release', () => {
    const v = fakeVersion('2.76.11');
    markBad(v, 'transient');
    expect(isBad(v)).toBe(true);
    const old = (Date.now() - BAD_MARKER_TTL_MS - 60_000) / 1000;
    fs.utimesSync(path.join(v, '.bad'), old, old);
    expect(isBad(v)).toBe(false);
  });
});
