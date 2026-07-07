/**
 * Real-git reproduce-first proof for the self-hosted "git pull/push → access
 * denied" fix. Unlike host-workspace.test.ts (which mocks child_process to
 * assert the COMMANDS issued), this exercises `configureGitCredentials` against
 * the SYSTEM git binary in a throwaway repo, proving the credential plumbing
 * actually materialises the way git reads it.
 *
 * THE BUG: the only auth was the short-lived cloneToken embedded in origin's
 * URL. Git persists it into .git/config, so push/pull broke the moment the
 * token expired ("access denied"), and the token sat in .git/config as a stale
 * secret.
 *
 * THE FIX (asserted here): a repo-LOCAL `credential.helper store --file=…`
 * backed by a 0600 credentials file inside .git/, with the token STRIPPED from
 * origin. This file imports the function that did not exist pre-fix, so the
 * suite is red before the change and green after.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { configureGitCredentials } from '../src/commands/host/workspace';
import { isOwnerOnly } from '../src/lib/restrict-to-owner';

let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

describe('configureGitCredentials — real git (push/pull auth persists)', () => {
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-cred-'));
    execFileSync('git', ['init', '-q', repo]);
    git(repo, 'config', 'user.email', 'test@codeam.dev');
    git(repo, 'config', 'user.name', 'codeam-test');
    // Simulate the clone result: origin carries the short-lived token in its URL.
    git(
      repo,
      'remote',
      'add',
      'origin',
      'https://x-access-token:ghs_SHORTLIVED@github.com/owner/repo.git',
    );
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('points git at a 0600 store file with the token and strips the token from origin', async () => {
    await configureGitCredentials(repo, 'owner/repo', 'ghs_SHORTLIVED');

    // 1) The credential helper git will actually invoke for this repo is our
    //    scoped store file (this is what makes a later push/pull authenticate).
    const helpers = git(repo, 'config', '--local', '--get-all', 'credential.helper');
    expect(helpers).toContain('store --file=');
    // The stored path is forward-slash (OS-agnostic — git escapes backslashes),
    // so compare against the posix form on every platform.
    const credPosix = path.join(repo, '.git', 'codeam-credentials').split(path.sep).join('/');
    expect(helpers).toContain(credPosix);

    // 2) The token is GONE from origin — no secret left in .git/config.
    const originUrl = git(repo, 'remote', 'get-url', 'origin');
    expect(originUrl).toBe('https://github.com/owner/repo.git');
    expect(originUrl).not.toContain('ghs_SHORTLIVED');

    // 3) The credentials file holds the token at 0600.
    const credFile = path.join(repo, '.git', 'codeam-credentials');
    expect(fs.readFileSync(credFile, 'utf8')).toContain(
      'https://x-access-token:ghs_SHORTLIVED@github.com',
    );
    expect(isOwnerOnly(credFile)).toBe(true);

    // 4) git's credential machinery resolves OUR token from the helper for a
    //    github.com URL — i.e. a subsequent fetch/push is authenticated.
    //    GIT_TERMINAL_PROMPT=0 so that if the helper ever fails to supply the
    //    creds, git errors immediately instead of prompting (which would hang /
    //    fail on a /dev/tty-less CI runner) — turning a real regression into a
    //    clean test failure rather than a flaky timeout.
    const filled = execFileSync('git', ['-C', repo, 'credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    expect(filled).toContain('username=x-access-token');
    expect(filled).toContain('password=ghs_SHORTLIVED');
  });

  it('does NOT clobber an identity the box already has (existing repo config wins)', async () => {
    // beforeEach already set user.email/user.name on the repo. With an identity
    // present, fetch must never be consulted and the values stay untouched.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      await configureGitCredentials(repo, 'owner/repo', 'ghs_SHORTLIVED');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(git(repo, 'config', 'user.email')).toBe('test@codeam.dev');
      expect(git(repo, 'config', 'user.name')).toBe('codeam-test');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('is a no-op for a non-GitHub remote (leaves the box ambient auth alone)', async () => {
    await configureGitCredentials(repo, 'https://gitlab.com/owner/repo.git', 'ghs_SHORTLIVED');
    // No local helper added (git exits 1 on a missing key → treat as empty).
    let helpers = '';
    try {
      helpers = execFileSync(
        'git',
        ['-C', repo, 'config', '--local', '--get-all', 'credential.helper'],
        { encoding: 'utf8' },
      ).trim();
    } catch {
      helpers = '';
    }
    expect(helpers).toBe('');
    expect(fs.existsSync(path.join(repo, '.git', 'codeam-credentials'))).toBe(false);
  });
});

describe('configureGitCredentials — commit identity when the box has none', () => {
  let repo: string;
  let savedGlobal: string | undefined;
  let savedSystem: string | undefined;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-cred-id-'));
    execFileSync('git', ['init', '-q', repo]);
    git(repo, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git');
    // Isolate git config so the test machine's global identity can't leak in —
    // this forces the "box has no identity" branch deterministically.
    savedGlobal = process.env.GIT_CONFIG_GLOBAL;
    savedSystem = process.env.GIT_CONFIG_SYSTEM;
    process.env.GIT_CONFIG_GLOBAL = path.join(repo, 'no-global-gitconfig');
    process.env.GIT_CONFIG_SYSTEM = path.join(repo, 'no-system-gitconfig');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
    if (savedSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = savedSystem;
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('sets user.name from the GitHub login and falls back to the noreply email', async () => {
    // /user returns a login but a private (null) email — exactly the common case.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ login: 'octocat', email: null }),
      }),
    );

    await configureGitCredentials(repo, 'owner/repo', 'ghs_SHORTLIVED');

    expect(git(repo, 'config', '--local', 'user.name')).toBe('octocat');
    expect(git(repo, 'config', '--local', 'user.email')).toBe(
      'octocat@users.noreply.github.com',
    );
  });

  it('uses the public email when /user exposes one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ login: 'octocat', email: 'octo@example.com' }),
      }),
    );

    await configureGitCredentials(repo, 'owner/repo', 'ghs_SHORTLIVED');

    expect(git(repo, 'config', '--local', 'user.email')).toBe('octo@example.com');
  });
});
