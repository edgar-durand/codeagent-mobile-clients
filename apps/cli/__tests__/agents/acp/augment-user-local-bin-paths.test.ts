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

describe('augmentUserLocalBinPaths', () => {
  it('prepends the missing user-local bin dirs to PATH', () => {
    process.env.PATH = '/usr/bin:/bin';
    augmentUserLocalBinPaths();
    const localBin = path.join(fakeHome, '.local', 'bin');
    const parts = (process.env.PATH ?? '').split(path.delimiter);
    expect(parts).toContain(localBin);
    // Prepended, not appended — a freshly-installed binary must win any
    // stale same-named entry earlier in the inherited PATH.
    expect(parts.indexOf(localBin)).toBeLessThan(parts.indexOf('/usr/bin'));
  });

  it('does not duplicate a dir already present on PATH (idempotent)', () => {
    const localBin = path.join(fakeHome, '.local', 'bin');
    process.env.PATH = `${localBin}:/usr/bin`;
    augmentUserLocalBinPaths();
    let parts = (process.env.PATH ?? '').split(path.delimiter);
    expect(parts.filter((p) => p === localBin)).toHaveLength(1);
    // Calling it again is still a no-op.
    augmentUserLocalBinPaths();
    parts = (process.env.PATH ?? '').split(path.delimiter);
    expect(parts.filter((p) => p === localBin)).toHaveLength(1);
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
