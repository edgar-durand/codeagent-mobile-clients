import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  ensureCoderabbitInstalled,
  ensureInstallPrerequisites,
  summarizeInstallFailure,
} from '../../../src/agents/coderabbit/installer';
import type { OsStrategy } from '../../../src/os';
import type { HeadroomRunner } from '../../../src/commands/host/os-packages';

/**
 * Regression suite for the 2026-08-13 "CodeRabbit never worked" incident.
 *
 * CodeRabbit's `install.sh` aborts with `[ERROR] Missing required tools: - unzip`
 * before downloading anything when `unzip` (or `git`) is absent — the case on
 * every slim container / bare VPS. The installer used to (a) not provision that
 * prerequisite and (b) throw the script's own diagnosis away via
 * `stdio: 'inherit'` into a daemon with no tty, reporting only an opaque
 * "CodeRabbit CLI could not be installed".
 */

const SCRATCH: string[] = [];

afterEach(() => {
  for (const d of SCRATCH.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** OS strategy whose PATH contents are a mutable set, so an "install" can add to it. */
function fakeOs(present: Set<string>): OsStrategy {
  return {
    id: 'linux',
    findInPath: (n: string) => (present.has(n) ? `/usr/bin/${n}` : null),
    homeDir: () => '/home/test',
    augmentPath: () => {},
    scratchPath: (prefix: string) => {
      const d = path.join(tmpdir(), `${prefix}-test-${Math.random().toString(16).slice(2)}`);
      SCRATCH.push(d);
      return d;
    },
  } as unknown as OsStrategy;
}

function fakeRunner(
  which: (cmd: string) => boolean,
  run: HeadroomRunner['run'] = async () => ({ code: 0, stderr: '' }),
): HeadroomRunner {
  return { which, run };
}

describe('ensureInstallPrerequisites', () => {
  it('is a no-op when unzip + git are already on PATH', async () => {
    const run = vi.fn<HeadroomRunner['run']>(async () => ({ code: 0, stderr: '' }));
    const res = await ensureInstallPrerequisites(fakeOs(new Set(['unzip', 'git'])), {
      runner: fakeRunner(() => true, run),
    });
    expect(res).toEqual({ ok: true, extraPath: [] });
    expect(run).not.toHaveBeenCalled();
  });

  it('installs the missing tools via the detected package manager (non-interactive sudo)', async () => {
    const present = new Set(['git']);
    const run = vi.fn<HeadroomRunner['run']>(async () => {
      present.add('unzip'); // the install worked
      return { code: 0, stderr: '' };
    });
    const res = await ensureInstallPrerequisites(fakeOs(present), {
      runner: fakeRunner((c) => c === 'apt-get', run),
    });
    expect(res).toEqual({ ok: true, extraPath: [] });
    const [cmd, args] = run.mock.calls[0];
    // Non-root test process → sudo, and `-n` so a passworded box fails FAST
    // instead of blocking a headless daemon on a password prompt.
    expect(cmd).toBe('sudo');
    expect(args.slice(0, 2)).toEqual(['-n', 'apt-get']);
    expect(args).toContain('unzip');
  });

  it('falls back to a SCOPED python zipfile shim when unzip cannot be installed', async () => {
    const res = await ensureInstallPrerequisites(fakeOs(new Set(['git'])), {
      // no package manager, but python3 exists
      runner: fakeRunner(
        (c) => c === 'python3',
        async () => ({ code: 1, stderr: 'denied' }),
      ),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.extraPath).toHaveLength(1);
    const shim = path.join(res.extraPath[0], 'unzip');
    expect(existsSync(shim)).toBe(true);
    const body = readFileSync(shim, 'utf8');
    // Handles exactly the invocation install.sh makes: `unzip -q <zip> -d <dir>`.
    expect(body).toContain('python3 -m zipfile -e');
    expect(body).toContain('-d) dest=');
    // ⚠️ Scoped to a scratch dir — it must NEVER be written into ~/.local/bin,
    // where it would shadow a real unzip the user installs later.
    expect(res.extraPath[0]).not.toContain('/.local/bin');
  });

  it('returns an ACTIONABLE error when a prerequisite cannot be provided', async () => {
    const res = await ensureInstallPrerequisites(fakeOs(new Set(['unzip'])), {
      // git is missing and has no unprivileged substitute
      runner: fakeRunner(
        (c) => c === 'apt-get',
        async () => ({ code: 1, stderr: 'denied' }),
      ),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('git');
    // Names the exact command the user can run.
    expect(res.error).toContain('apt-get install');
  });
});

describe('summarizeInstallFailure', () => {
  it('extracts CodeRabbit’s own diagnosis, including the missing-tool bullets', () => {
    // VERBATIM bytes from the real installer (2026-08-13, fleet-1) — the ESC
    // sequences are load-bearing: a fixture without them would pass a stripper
    // that only removes the `[0;31m` tail and leaves the ESC glued to the text.
    const raw =
      '\u001b[0;31m[ERROR] Missing required tools:\n  - unzip\nPlease install the missing tools before proceeding\u001b[0m\n';
    expect(summarizeInstallFailure(raw)).toBe('Missing required tools: - unzip');
  });

  it('falls back to the last line when there is no [ERROR] marker', () => {
    expect(summarizeInstallFailure('downloading…\ncurl: (6) Could not resolve host')).toBe(
      'curl: (6) Could not resolve host',
    );
  });

  it('returns null on empty output', () => {
    expect(summarizeInstallFailure('   \n\n')).toBeNull();
  });
});

describe('ensureCoderabbitInstalled', () => {
  it('short-circuits when the binary is already present', async () => {
    const runInstallScript = vi.fn();
    const res = await ensureCoderabbitInstalled(fakeOs(new Set(['coderabbit'])), {
      runInstallScript,
    });
    expect(res).toEqual({ ok: true });
    expect(runInstallScript).not.toHaveBeenCalled();
  });

  it('NEVER runs the install script when a prerequisite is missing — reports why', async () => {
    const runInstallScript = vi.fn();
    const res = await ensureCoderabbitInstalled(fakeOs(new Set()), {
      runner: fakeRunner(() => false),
      runInstallScript,
    });
    expect(runInstallScript).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unzip/);
  });

  it('exports the shim dir on the install script’s PATH, not the parent process’ PATH', async () => {
    const present = new Set(['git']);
    let seenPath = '';
    const before = process.env.PATH;
    const res = await ensureCoderabbitInstalled(fakeOs(present), {
      runner: fakeRunner(
        (c) => c === 'python3',
        async () => ({ code: 1, stderr: '' }),
      ),
      runInstallScript: async (env) => {
        seenPath = env.PATH ?? '';
        present.add('coderabbit');
        return { code: 0, output: '' };
      },
    });
    expect(res).toEqual({ ok: true });
    expect(seenPath).toContain('codeam-cr-prereq');
    expect(process.env.PATH).toBe(before);
  });

  it('surfaces the install script’s real error instead of a generic message', async () => {
    const res = await ensureCoderabbitInstalled(fakeOs(new Set(['unzip', 'git'])), {
      runner: fakeRunner(() => true),
      runInstallScript: async () => ({
        code: 1,
        output: '[ERROR] Missing required tools:\n  - unzip\n',
      }),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('CodeRabbit CLI install failed: Missing required tools: - unzip');
  });

  it('fails honestly when the script exits 0 but produces no binary', async () => {
    const res = await ensureCoderabbitInstalled(fakeOs(new Set(['unzip', 'git'])), {
      runner: fakeRunner(() => true),
      runInstallScript: async () => ({ code: 0, output: 'done\n' }),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/did not produce a binary|no `coderabbit` binary/);
  });

  it('SUCCEEDS when the script exits non-zero but the binary is installed', async () => {
    // CodeRabbit's install.sh 0.7.2 exits 2 on a fully successful install
    // (reproduced on linux-amd64 AND linux-arm64 by the real-install gate).
    // The binary — not the vendor exit code — is the authority, otherwise
    // every user with a working install is told
    // "install failed: [SUCCESS] Installation complete".
    const present = new Set(['unzip', 'git']);
    const res = await ensureCoderabbitInstalled(fakeOs(present), {
      runner: fakeRunner(() => true),
      runInstallScript: async () => {
        present.add('coderabbit');
        return {
          code: 2,
          output: '[SUCCESS] Installation verified\n[SUCCESS] Installation complete\n',
        };
      },
    });
    expect(res).toEqual({ ok: true });
  });
});
