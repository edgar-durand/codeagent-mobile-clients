import { describe, it, expect } from 'vitest';
import { ensurePythonInstaller, type HeadroomRunner } from '../../src/commands/host/os-packages';
import { setupHeadroomForSelfHosted } from '../../src/commands/host/headroom-bootstrap';

/**
 * How Headroom gets a Python package installer on the box.
 *
 * Root cause this covers (2026-08-21, fleet-1): the old `ensurePip` had exactly
 * two paths — pip already on PATH, or install it with the OS package manager
 * through `sudo`. There was NO root-free route. Edgar's 24/7 session runs on
 * fleet-1 as the non-root user `codeam-edgar` inside a TTY-less systemd unit, so
 * sudo cannot prompt:
 *
 *   headroom[sudo]: sudo: a terminal is required to read the password
 *   headroom[sudo]: sudo: a password is required
 *   apt-get bare-box provision failed (code=1) — skipping Headroom
 *
 * …four times, once per Retry, surfacing in the dashboard as a bare
 * "Cost-saving failed". Verified on that box: python3 3.12.3 present, pip
 * genuinely absent (Ubuntu 24.04 splits out `python3-pip`), `python3 -m
 * ensurepip` ALSO absent (Debian strips it from stdlib, so there is no
 * stdlib bootstrap), and `sudo -n true` fails.
 *
 * What IS there: `uv`. Proven on the same box as that user —
 * `uv pip install --python /usr/bin/python3 --break-system-packages` resolves
 * headroom-ai[proxy,code,image] (57 packages) into the `/usr` environment, i.e.
 * exactly where pip would have put the `headroom` script, so `which('headroom')`
 * keeps working with no PATH threading anywhere.
 */
function makeRunner(
  presentCmds: string[],
  responses: Record<string, { code: number | null; stderr: string; stdout?: string }> = {},
): HeadroomRunner & { calls: Array<{ cmd: string; args: string[] }> } {
  const present = new Set(presentCmds);
  const calls: Array<{ cmd: string; args: string[] }> = [];
  return {
    calls,
    which: (cmd: string) => present.has(cmd),
    run: (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return Promise.resolve(responses[cmd] ?? { code: 0, stderr: '' });
    },
  };
}

const isRoot = process.getuid?.() === 0;

describe('ensurePythonInstaller', () => {
  it('uses pip when it is already on PATH, touching nothing else', async () => {
    const r = makeRunner(['pip']);
    const res = await ensurePythonInstaller(r);
    expect(res).toEqual({ ok: true, installer: { kind: 'pip' } });
    expect(r.calls).toEqual([]);
  });

  it('accepts pip3 as well', async () => {
    const r = makeRunner(['pip3']);
    const res = await ensurePythonInstaller(r);
    expect(res.ok).toBe(true);
  });

  // THE FIX. No sudo, no package manager, no network — uv is already there.
  it('falls back to uv when pip is absent — with NO sudo and NO package manager', async () => {
    const r = makeRunner(['uv', 'apt-get']);
    const res = await ensurePythonInstaller(r);
    expect(res).toEqual({ ok: true, installer: { kind: 'uv', bin: 'uv' } });
    // The whole point: nothing was escalated and no mirror was touched.
    expect(r.calls.map((c) => c.cmd)).not.toContain('sudo');
    expect(r.calls.map((c) => c.cmd)).not.toContain('apt-get');
  });

  it('prefers uv over the package manager even when both exist (root-free wins)', async () => {
    const r = makeRunner(['uv', 'apt-get', 'dnf']);
    const res = await ensurePythonInstaller(r);
    expect(res.ok && res.installer.kind).toBe('uv');
    expect(r.calls).toEqual([]);
  });

  // Previously this burned up to 180 s on `sudo apt-get update` before failing
  // with a message no user could act on. Now it is refused instantly, with a
  // reason that says what to install.
  (isRoot ? it.skip : it)(
    'refuses instantly when sudo needs a password, naming what to install',
    async () => {
      const r = makeRunner(['apt-get'], { sudo: { code: 1, stderr: 'sudo: a password is required' } });
      const res = await ensurePythonInstaller(r);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.reason).toMatch(/password/i);
      expect(res.reason).toMatch(/python3-pip|uv/i);
      // Only the `sudo -n true` probe ran — never the real install.
      expect(r.calls.filter((c) => c.args.includes('install'))).toEqual([]);
    },
  );

  (isRoot ? it.skip : it)('does attempt the install when passwordless sudo works', async () => {
    const r = makeRunner(['apt-get'], { sudo: { code: 0, stderr: '' } });
    const res = await ensurePythonInstaller(r);
    expect(res).toEqual({ ok: true, installer: { kind: 'pip' } });
    expect(r.calls.some((c) => c.args.includes('install'))).toBe(true);
  });

  it('reports a reason when there is no pip, no uv and no package manager', async () => {
    const r = makeRunner([]);
    const res = await ensurePythonInstaller(r);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toMatch(/package manager|uv/i);
    expect(r.calls).toEqual([]);
  });

  (isRoot ? it.skip : it)('reports the exit code when the package-manager install fails', async () => {
    const r = makeRunner(['apt-get'], {
      sudo: { code: 0, stderr: '' },
      'apt-get': { code: 0, stderr: '' },
    });
    // `sudo` is the escalated cmd for both the probe and the install; make the
    // install itself fail by failing every escalated call after the probe.
    let seenProbe = false;
    r.run = (cmd: string, args: string[]) => {
      r.calls.push({ cmd, args });
      if (!seenProbe && args.includes('true')) {
        seenProbe = true;
        return Promise.resolve({ code: 0, stderr: '' });
      }
      return Promise.resolve({ code: 100, stderr: 'E: Unable to locate package' });
    };
    const res = await ensurePythonInstaller(r);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toMatch(/100/);
  });
});

/**
 * The install itself has to go THROUGH the resolved installer. Resolving `uv`
 * and then still shelling `<py> -m pip install` would fail on the very box the
 * uv route exists for — pip is absent there.
 *
 * Verified argv on fleet-1 (dry-run, as the non-root user):
 *   uv pip install --python /usr/bin/python3 --break-system-packages \
 *     "headroom-ai[proxy,code,image]"
 * → "Using Python 3.12.3 environment at: /usr" + 57 packages resolved. Same
 * environment pip would have targeted, so `which('headroom')` needs no help.
 */
describe('setupHeadroomForSelfHosted — install routing', () => {
  function bootRunner(present: string[]) {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: HeadroomRunner = {
      which: (cmd: string) => present.includes(cmd),
      run: (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        // Interpreter version probe → 3.11 so the resolver settles on python3.
        if (args.length === 2 && args[0] === '-c' && args[1]?.includes('sys.version_info')) {
          return Promise.resolve({ code: 0, stderr: '', stdout: '3.11' });
        }
        return Promise.resolve({ code: 0, stderr: '' });
      },
    };
    return { runner, calls };
  }

  it('installs via uv (never `python -m pip`) when uv is the resolved installer', async () => {
    // uv + python3 present, pip absent, headroom absent → init is skipped and
    // the overall result is false, but the INSTALL argv is what we assert.
    const { runner, calls } = bootRunner(['uv', 'python3']);
    await setupHeadroomForSelfHosted('claude', runner, { modelsCached: () => false });

    const uvInstall = calls.find((c) => c.cmd === 'uv' && c.args.includes('install'));
    expect(uvInstall).toBeDefined();
    expect(uvInstall?.args).toContain('pip');
    expect(uvInstall?.args).toContain('--python');
    expect(uvInstall?.args).toContain('--break-system-packages');
    // The headroom package with its extras must be in there.
    expect(uvInstall?.args.some((a) => a.startsWith('headroom-ai['))).toBe(true);
    // And no INSTALL may have gone through the interpreter's pip. (Bare
    // `<py> -m pip --version` probes from the interpreter resolver are fine and
    // expected — it is specifically `install` that must not take that route.)
    const pipInstallViaPy = calls.find(
      (c) => c.args[0] === '-m' && c.args[1] === 'pip' && c.args.includes('install'),
    );
    expect(pipInstallViaPy).toBeUndefined();
  });

  it('still installs via `python -m pip` when pip is the resolved installer', async () => {
    const { runner, calls } = bootRunner(['pip', 'python3']);
    await setupHeadroomForSelfHosted('claude', runner, { modelsCached: () => false });

    const pipViaPy = calls.find(
      (c) => c.args[0] === '-m' && c.args[1] === 'pip' && c.args.includes('install'),
    );
    expect(pipViaPy).toBeDefined();
    expect(calls.find((c) => c.cmd === 'uv')).toBeUndefined();
  });
});
