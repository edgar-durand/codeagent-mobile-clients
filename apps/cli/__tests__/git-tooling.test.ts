/**
 * Self-hosted gh tooling — install `gh` if absent, authenticate it with the
 * user's token UNLESS the box already has a login (no clobber). All best-effort:
 * any failure returns null / no-ops so the deploy is never blocked (the git
 * credential helper already makes pull/push work without `gh`).
 *
 * Pure unit tests: injected runner + injected download/version, an env-overridden
 * bin dir, and no real network or `gh`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ensureGhCli,
  ensureGhAuth,
  ghConfigDir,
  type GitToolingRunner,
} from '../src/commands/host/git-tooling';

function makeRunner(over: Partial<GitToolingRunner> = {}): GitToolingRunner {
  return {
    which: over.which ?? (() => false),
    run: over.run ?? (async () => ({ code: 0, stderr: '' })),
  };
}

describe('ensureGhCli', () => {
  let binDir: string;

  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-bin-'));
    process.env.CODEAM_BIN_DIR = binDir;
  });
  afterEach(() => {
    delete process.env.CODEAM_BIN_DIR;
    fs.rmSync(binDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns "gh" without installing when gh is already on PATH', async () => {
    const downloadFn = vi.fn();
    const result = await ensureGhCli(makeRunner({ which: () => true }), 'tok', { downloadFn });
    expect(result).toBe('gh');
    expect(downloadFn).not.toHaveBeenCalled();
  });

  it('returns null (never throws) when the download fails', async () => {
    const result = await ensureGhCli(makeRunner({ which: () => false }), 'tok', {
      downloadFn: async () => false,
      resolveVersionFn: async () => '2.62.0',
    });
    expect(result).toBeNull();
  });

  it('installs the binary to the bin dir and returns its path on success', async () => {
    // Per-OS binary name (gh.exe on Windows). The feature is OS-agnostic.
    const binaryName = process.platform === 'win32' ? 'gh.exe' : 'gh';
    // The injected runner stands in for `tar -xf`: it materialises the
    // extracted gh binary at <tmpRoot>/<asset>/bin/<binaryName> so the copy-out
    // step succeeds.
    const runner = makeRunner({
      which: () => false,
      run: async (_cmd, args) => {
        const ci = args.indexOf('-C');
        const tmpRoot = args[ci + 1];
        const archive = args.find((a) => a.endsWith('.tar.gz') || a.endsWith('.zip'))!;
        const asset = path.basename(archive).replace(/\.(tar\.gz|zip)$/, '');
        fs.mkdirSync(path.join(tmpRoot, asset, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(tmpRoot, asset, 'bin', binaryName), '#!/bin/sh\n');
        return { code: 0, stderr: '' };
      },
    });
    const result = await ensureGhCli(runner, 'tok', {
      downloadFn: async () => true,
      resolveVersionFn: async () => '2.62.0',
    });
    expect(result).toBe(path.join(binDir, binaryName));
    expect(fs.existsSync(path.join(binDir, binaryName))).toBe(true);
  });
});

describe('ensureGhAuth', () => {
  it('does NOT log in when gh is already authenticated (no clobber)', async () => {
    const calls: string[][] = [];
    const runner = makeRunner({
      run: async (_cmd, args) => {
        calls.push(args);
        return { code: 0, stderr: '' }; // `gh auth status` → already authed
      },
    });
    await ensureGhAuth(runner, 'gh', 'tok');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['auth', 'status']);
  });

  it('logs in with the token when gh is NOT authenticated', async () => {
    const calls: { args: string[]; input?: string }[] = [];
    const runner = makeRunner({
      run: async (_cmd, args, opts) => {
        calls.push({ args, input: opts?.input });
        // First call (status) fails → triggers login; login succeeds.
        return { code: args[1] === 'status' ? 1 : 0, stderr: '' };
      },
    });
    await ensureGhAuth(runner, 'gh', 'my-secret-token');
    const login = calls.find((c) => c.args[1] === 'login');
    expect(login).toBeTruthy();
    expect(login?.args).toEqual(['auth', 'login', '--with-token']);
    expect(login?.input).toContain('my-secret-token');
  });

  // Fleet box 2026-09-24: the app's GitHub token has scopes codespace, repo,
  // user:email. `gh auth login --with-token` rejects it for lacking read:org,
  // so every Box session had an unauthenticated gh and the ticket flow could
  // never open its PR. gh works with that token once it is stored.
  describe('token without read:org', () => {
    let cfg: string;
    beforeEach(() => {
      cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-gh-'));
      process.env.GH_CONFIG_DIR = cfg;
    });
    afterEach(() => {
      delete process.env.GH_CONFIG_DIR;
      fs.rmSync(cfg, { recursive: true, force: true });
    });
    const scopeRejectingGh = makeRunner({
      run: async (_cmd, args) =>
        args[1] === 'status'
          ? { code: 1, stderr: 'You are not logged into any GitHub hosts.' }
          : { code: 1, stderr: "error validating token: missing required scope 'read:org'" },
    });

    it('stores the token in hosts.yml (0600) so gh is logged in', async () => {
      await ensureGhAuth(scopeRejectingGh, 'gh', 'gho_secret');
      const file = path.join(ghConfigDir(), 'hosts.yml');
      expect(fs.readFileSync(file, 'utf8')).toBe(
        'github.com:\n    oauth_token: gho_secret\n    git_protocol: https\n',
      );
      if (process.platform !== 'win32') {
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      }
    });

    it('never overwrites an existing hosts.yml', async () => {
      const file = path.join(cfg, 'hosts.yml');
      fs.writeFileSync(file, 'ghe.example.com:\n    oauth_token: other\n');
      await ensureGhAuth(scopeRejectingGh, 'gh', 'gho_secret');
      expect(fs.readFileSync(file, 'utf8')).toBe('ghe.example.com:\n    oauth_token: other\n');
    });

    it('does not write hosts.yml when login fails for another reason', async () => {
      const runner = makeRunner({
        run: async (_cmd, args) =>
          args[1] === 'status' ? { code: 1, stderr: '' } : { code: 1, stderr: 'HTTP 401: Bad credentials' },
      });
      await ensureGhAuth(runner, 'gh', 'gho_bad');
      expect(fs.existsSync(path.join(cfg, 'hosts.yml'))).toBe(false);
    });
  });
});
