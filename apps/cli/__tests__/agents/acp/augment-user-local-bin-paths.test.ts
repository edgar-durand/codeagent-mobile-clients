/**
 * Regression coverage for the SECOND fleet-1 (2026-08-14) codex switch
 * failure — found after fixing the half-finished-npm-bin-link retry in
 * `switch-agent.ts` and the failure still recurred. Root cause: `codeam
 * host-agent` runs as a systemd unit whose process PATH lacked `~/.local/bin`
 * entirely, so the codex adapter's bare `waitForCommandOnPath('codex')` could
 * never see the binary `npm install -g @openai/codex` had actually installed
 * there — the install "succeeded" but the probe failed forever, so every
 * mention re-ran the (already-successful) install. Same stale-PATH class as
 * kimi/opencode's `augmentKimiPath`/`augmentOpencodePath`, generalized to
 * npm `-g`-installed agent binaries via `augmentUserLocalBinPaths`.
 *
 * `os.homedir()` can't be reliably spied in ESM / on macOS (see
 * `house-proxy-config.test.ts`), so — matching that file's convention — we
 * mock `node:os` and route `homedir()` through a mutable holder pointed at a
 * real throwaway temp dir per test. Never touches the real user's
 * `~/.local/bin`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const homeHolder = vi.hoisted(() => ({ dir: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => homeHolder.dir },
    homedir: () => homeHolder.dir,
  };
});

import { augmentUserLocalBinPaths } from '../../../src/agents/acp/agent-binary';
import { getAcpAdapter } from '../../../src/agents/acp/adapters';

let fakeHome: string;
let originalPath: string | undefined;

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-augment-path-'));
  homeHolder.dir = fakeHome;
  originalPath = process.env.PATH;
});

afterEach(() => {
  process.env.PATH = originalPath;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

// Inherited-PATH fixtures are built with the HOST's `path.delimiter` (`:`
// POSIX, `;` win32). Hard-coding `'/usr/bin:/bin'` made the win32 matrix
// split it into ONE opaque entry, so `indexOf('/usr/bin')` was -1 and the
// "prepended" ordering assertion failed (`expected 0 to be less than -1`,
// main cross-OS run 2026-08-19).
const SYS_BIN = path.resolve(path.sep, 'usr', 'bin');
const BIN = path.resolve(path.sep, 'bin');
const joinPath = (...dirs: string[]): string => dirs.join(path.delimiter);
const splitPath = (): string[] => (process.env.PATH ?? '').split(path.delimiter);

describe('augmentUserLocalBinPaths', () => {
  it('prepends the missing user-local bin dirs to PATH', () => {
    process.env.PATH = joinPath(SYS_BIN, BIN);
    augmentUserLocalBinPaths();
    const localBin = path.join(fakeHome, '.local', 'bin');
    const parts = splitPath();
    expect(parts).toContain(localBin);
    expect(parts).toContain(SYS_BIN);
    // Prepended, not appended — a freshly-installed binary must win any
    // stale same-named entry earlier in the inherited PATH.
    expect(parts.indexOf(localBin)).toBeLessThan(parts.indexOf(SYS_BIN));
  });

  it('does not duplicate a dir already present on PATH (idempotent)', () => {
    const localBin = path.join(fakeHome, '.local', 'bin');
    process.env.PATH = joinPath(localBin, SYS_BIN);
    augmentUserLocalBinPaths();
    let parts = splitPath();
    expect(parts.filter((p) => p === localBin)).toHaveLength(1);
    // Calling it again is still a no-op.
    augmentUserLocalBinPaths();
    parts = splitPath();
    expect(parts.filter((p) => p === localBin)).toHaveLength(1);
  });

  // The fleet-1 incident was Linux, but the stale-PATH class is NOT POSIX-only
  // (cf. the cursor-agent Windows trap in `resolveCursorAgentBinary`), so the
  // augment must behave on win32 too: `;`-delimited PATH, backslash dirs.
  // Exercised from any host via the deps seam (`path.win32` + explicit env).
  it('uses the win32 delimiter and path shape when given path.win32', () => {
    const env: NodeJS.ProcessEnv = { PATH: 'C:\\Windows\\system32;C:\\Windows' };
    augmentUserLocalBinPaths({ env, homedir: 'C:\\Users\\box', pathApi: path.win32 });
    const parts = (env.PATH ?? '').split(';');
    expect(parts[0]).toBe('C:\\Users\\box\\.local\\bin');
    expect(parts).toContain('C:\\Users\\box\\.npm-global\\bin');
    expect(parts).toContain('C:\\Users\\box\\.local\\share\\npm\\bin');
    expect(parts.indexOf('C:\\Windows\\system32')).toBeGreaterThan(
      parts.indexOf('C:\\Users\\box\\.local\\bin'),
    );
    // Still idempotent under the win32 shape — no duplicates on a second call,
    // and no `:`-splitting of the drive letter.
    augmentUserLocalBinPaths({ env, homedir: 'C:\\Users\\box', pathApi: path.win32 });
    expect((env.PATH ?? '').split(';').filter((p) => p === 'C:\\Users\\box\\.local\\bin')).toHaveLength(1);
    expect(env.PATH).not.toContain(':/');
  });

  it('produces the exact POSIX PATH shape when given path.posix (host-independent)', () => {
    const posixEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    augmentUserLocalBinPaths({ env: posixEnv, homedir: '/home/box', pathApi: path.posix });
    expect(posixEnv.PATH).toBe(
      '/home/box/.local/bin:/home/box/.npm-global/bin:/home/box/.local/share/npm/bin:/usr/bin:/bin',
    );
  });

  // POSIX-only: relies on chmod +x and `which` PATH resolution semantics
  // that don't carry over to Windows (the fleet-1 incident this guards was a
  // Linux systemd unit).
  it.skipIf(process.platform === 'win32')(
    "codex adapter's waitForBinary finds an installed-but-off-PATH binary after augmentation",
    async () => {
      const localBin = path.join(fakeHome, '.local', 'bin');
      fs.mkdirSync(localBin, { recursive: true });
      const codexPath = path.join(localBin, 'codex');
      fs.writeFileSync(codexPath, '#!/bin/sh\necho fake codex\n');
      fs.chmodSync(codexPath, 0o755);
      // PATH deliberately does NOT include the fake ~/.local/bin — mirrors
      // the systemd unit whose inherited PATH lacked it.
      process.env.PATH = '/usr/bin:/bin';

      const spec = getAcpAdapter('codex');
      expect(spec).not.toBeNull();
      const found = await spec!.waitForBinary({ timeoutMs: 0 });
      expect(found).toBe(true);
    },
  );
});
