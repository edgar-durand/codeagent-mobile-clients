import fs from 'node:fs';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { promisify } from 'node:util';
import type { execFile as ExecFileType } from 'node:child_process';
import { saveToGithub } from '../../src/scratch/save-github';

const GH = 'https://api.github.com';

interface GitCall {
  args: string[];
  env: NodeJS.ProcessEnv;
}

function ok(body: unknown, status = 200): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: status < 300, status, json: () => Promise.resolve(body) };
}

/**
 * A fake `execFile` that records every git invocation and answers via
 * `util.promisify.custom` — exactly how Node's real `execFile` resolves to
 * `{stdout, stderr}` (a plain callback mock would only get promisify's
 * generic single-value behavior, dropping `stderr`).
 */
function makeExec(
  calls: GitCall[],
  opts: {
    statusOutput?: string;
    branch?: string;
    bareConfig?: string;
    failOn?: (args: string[]) => Error | undefined;
  } = {},
): typeof ExecFileType {
  const fn = (() => {
    throw new Error('unexpected direct call — this mock only implements util.promisify.custom');
  }) as unknown as typeof ExecFileType;
  Object.defineProperty(fn, promisify.custom, {
    value: async (
      _file: string,
      args: string[],
      execOpts: { env: NodeJS.ProcessEnv },
    ): Promise<{ stdout: string; stderr: string }> => {
      calls.push({ args, env: execOpts.env });
      const failure = opts.failOn?.(args);
      if (failure) throw failure;
      if (args.includes('status')) return { stdout: opts.statusOutput ?? '', stderr: '' };
      if (args.includes('symbolic-ref')) return { stdout: `${opts.branch ?? 'main'}\n`, stderr: '' };
      if (args.includes('--name-only')) {
        return { stdout: opts.bareConfig ?? 'core.bare\nremote.origin.url\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
  });
  return fn;
}

describe('saveToGithub', () => {
  it('creates the repo, commits pending changes, pushes with the token ONLY in env', async () => {
    const gitCalls: GitCall[] = [];
    const exec = makeExec(gitCalls, { statusOutput: ' M index.html\n' });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok({ login: 'me', id: 7 }))
      .mockResolvedValueOnce(
        ok(
          {
            full_name: 'me/landing',
            clone_url: 'https://github.com/me/landing.git',
            html_url: 'https://github.com/me/landing',
          },
          201,
        ),
      );
    const dir = '/tmp/fake-scratch-repo';

    const out = await saveToGithub(
      dir,
      { repoName: 'landing', private: true, token: 'gho_secret' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, exec },
    );

    expect(out).toEqual({ repoFullName: 'me/landing', htmlUrl: 'https://github.com/me/landing' });

    // GET /user carries the bearer token in a header, never elsewhere.
    const [userUrl, userInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(userUrl).toBe(`${GH}/user`);
    expect((userInit.headers as Record<string, string>).Authorization).toBe('Bearer gho_secret');

    // POST /user/repos body matches exactly — no extra fields, auto_init off.
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({
      name: 'landing',
      private: true,
      auto_init: false,
    });

    // Pending changes are committed under the GitHub user's own identity.
    expect(
      gitCalls.some((c) => c.args.join(' ').includes('user.email 7+me@users.noreply.github.com')),
    ).toBe(true);
    expect(gitCalls.some((c) => c.args.includes('add') && c.args.includes('-A'))).toBe(true);
    expect(
      gitCalls.some((c) => c.args.includes('commit') && c.args.includes('Save project from CodeAgent')),
    ).toBe(true);

    // The remote is (re)pointed at the freshly created repo.
    expect(
      gitCalls.some(
        (c) => c.args.includes('remote') && c.args.includes('add') && c.args.includes('https://github.com/me/landing.git'),
      ),
    ).toBe(true);

    // The push authenticates with an HTTP header delivered through git's
    // env-config (GIT_CONFIG_*), never argv/URL and never the credential
    // subsystem: the generic helper list is emptied and no helper is added.
    const push = gitCalls.find((c) => c.args.includes('push'))!;
    // The push runs from a CLEAN bare copy (never the agent-writable working
    // repo), cloned right before it, to the new repo's URL given explicitly.
    const clone = gitCalls.find((c) => c.args.includes('clone'))!;
    const bare = push.args[1];
    expect(clone.args).toEqual(['clone', '--bare', '--no-hardlinks', '--template=', '-q', dir, bare]);
    // The clone runs in the SAME isolated env as the push, minus the token:
    // no system/global config (so no init.templateDir), throwaway HOME.
    expect(clone.env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(clone.env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(clone.env.HOME).toBe(push.env.HOME);
    expect(clone.env.GIT_CONFIG_VALUE_0).toBeUndefined();
    // The bare copy's config is inspected before the push.
    const check = gitCalls.find((c) => c.args.includes('--name-only'))!;
    expect(check.args).toEqual(['-C', bare, 'config', '--local', '--list', '--name-only']);
    expect(gitCalls.indexOf(check)).toBeLessThan(gitCalls.indexOf(push));
    expect(bare.startsWith(os.tmpdir())).toBe(true);
    expect(bare).not.toContain(dir);
    expect(push.args).toEqual([
      '-C',
      bare,
      '-c',
      'credential.helper=',
      '-c',
      'credential.interactive=never',
      // No repo hook (pre-push, …) ever runs while the header is in env.
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'http.sslVerify=true',
      '-c',
      'http.proxy=',
      'push',
      'https://github.com/me/landing.git',
      'HEAD:main',
    ]);
    // No system/global config, and a throwaway HOME, for the push.
    expect(push.env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(push.env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(push.env.HOME).not.toBe(process.env.HOME);
    expect(push.env.HOME!.startsWith(os.tmpdir())).toBe(true);
    // Both temp dirs are gone afterwards.
    expect(fs.existsSync(bare)).toBe(false);
    expect(fs.existsSync(push.env.HOME!)).toBe(false);
    // The working repo gets origin + upstream so later pushes just work.
    const argsOf = (c: GitCall) => c.args.slice(2).join(' ');
    const rest = gitCalls.filter((c) => c.args[0] === '-C' && c.args[1] === dir).map(argsOf);
    expect(rest).toContain('remote add origin https://github.com/me/landing.git');
    expect(rest).toContain('config branch.main.remote origin');
    expect(rest).toContain('config branch.main.merge refs/heads/main');
    expect(push.args.filter((a) => /^credential\.helper=./.test(a))).toEqual([]);
    const b64 = Buffer.from('x-access-token:gho_secret').toString('base64');
    expect(push.env.GIT_CONFIG_COUNT).toBe('1');
    expect(push.env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/me/landing.git.extraheader');
    expect(push.env.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${b64}`);
    expect(push.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(push.env.GCM_INTERACTIVE).toBe('never');
    expect(push.env.CODEAM_GH_TOKEN).toBeUndefined();

    // (a) Neither the secret nor its base64 ever reaches ANY git argv.
    for (const call of gitCalls) {
      expect(call.args.join(' ')).not.toContain('gho_secret');
      expect(call.args.join(' ')).not.toContain(b64);
    }

    // (b) ONLY the push call's env carries the header — config/status/add/
    // commit/remote run under the plain env (repo hooks may run there).
    for (const call of gitCalls) {
      if (call.args.includes('push')) continue;
      expect(call.env.GIT_CONFIG_VALUE_0).toBeUndefined();
      expect(call.env.GIT_CONFIG_COUNT).toBeUndefined();
      expect(JSON.stringify(call.env)).not.toContain(b64);
    }
  });

  it('a revoked/expired token (401 on GET /user) rejects SAVE_FAILED and makes NO git calls', async () => {
    const gitCalls: GitCall[] = [];
    const exec = makeExec(gitCalls);
    const fetchImpl = vi.fn().mockResolvedValueOnce(ok({ message: 'Bad credentials' }, 401));

    await expect(
      saveToGithub(
        '/tmp/fake-scratch-repo',
        { repoName: 'landing', private: true, token: 'gho_revoked' },
        { fetchImpl: fetchImpl as unknown as typeof fetch, exec },
      ),
    ).rejects.toMatchObject({
      code: 'SAVE_FAILED',
      message: 'GitHub rejected the token — reconnect GitHub and try again.',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(gitCalls).toHaveLength(0);
  });

  it('a malformed 200 /user response (missing login/id) rejects SAVE_FAILED and makes NO git calls', async () => {
    const gitCalls: GitCall[] = [];
    const exec = makeExec(gitCalls);
    const fetchImpl = vi.fn().mockResolvedValueOnce(ok({ login: 'me' })); // id missing

    await expect(
      saveToGithub(
        '/tmp/fake-scratch-repo',
        { repoName: 'landing', private: true, token: 'gho_secret' },
        { fetchImpl: fetchImpl as unknown as typeof fetch, exec },
      ),
    ).rejects.toMatchObject({ code: 'SAVE_FAILED' });

    expect(gitCalls).toHaveLength(0);
  });

  it('skips add/commit when there are no pending changes', async () => {
    const gitCalls: GitCall[] = [];
    const exec = makeExec(gitCalls, { statusOutput: '' });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok({ login: 'me', id: 7 }))
      .mockResolvedValueOnce(
        ok({ full_name: 'me/x', clone_url: 'https://github.com/me/x.git', html_url: 'https://github.com/me/x' }, 201),
      );

    await saveToGithub(
      '/tmp/fake-scratch-repo',
      { repoName: 'x', private: false, token: 'gho_y' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, exec },
    );

    expect(gitCalls.some((c) => c.args.includes('commit'))).toBe(false);
    // `c.args.includes('add')` alone would also match `remote add origin …` —
    // scope the check to the staging call specifically (`add -A`).
    expect(gitCalls.some((c) => c.args.includes('add') && c.args.includes('-A'))).toBe(false);
  });

  it('422 "name already exists" → REPO_NAME_TAKEN, no push', async () => {
    const gitCalls: GitCall[] = [];
    const exec = makeExec(gitCalls);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok({ login: 'me', id: 7 }))
      .mockResolvedValueOnce(ok({ errors: [{ message: 'name already exists on this account' }] }, 422));

    await expect(
      saveToGithub(
        '/tmp/fake-scratch-repo',
        { repoName: 'landing', private: true, token: 'gho_secret' },
        { fetchImpl: fetchImpl as unknown as typeof fetch, exec },
      ),
    ).rejects.toMatchObject({
      code: 'REPO_NAME_TAKEN',
      message: 'A repository with that name already exists.',
    });

    expect(gitCalls.some((c) => c.args.includes('push'))).toBe(false);
    expect(gitCalls.some((c) => c.args.includes('remote'))).toBe(false);
  });

  it('a non-422 GitHub failure maps to SAVE_FAILED', async () => {
    const gitCalls: GitCall[] = [];
    const exec = makeExec(gitCalls);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok({ login: 'me', id: 7 }))
      .mockResolvedValueOnce(ok({ message: 'Internal Server Error' }, 500));

    await expect(
      saveToGithub(
        '/tmp/fake-scratch-repo',
        { repoName: 'landing', private: true, token: 'gho_secret' },
        { fetchImpl: fetchImpl as unknown as typeof fetch, exec },
      ),
    ).rejects.toMatchObject({ code: 'SAVE_FAILED' });

    expect(gitCalls.some((c) => c.args.includes('push'))).toBe(false);
  });

  it('a failing git push maps to SAVE_FAILED with the first line of the error', async () => {
    const gitCalls: GitCall[] = [];
    const exec = makeExec(gitCalls, {
      failOn: (args) =>
        args.includes('push') ? new Error('fatal: could not read Username\nextra detail line') : undefined,
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok({ login: 'me', id: 7 }))
      .mockResolvedValueOnce(
        ok(
          {
            full_name: 'me/landing',
            clone_url: 'https://github.com/me/landing.git',
            html_url: 'https://github.com/me/landing',
          },
          201,
        ),
      );

    await expect(
      saveToGithub(
        '/tmp/fake-scratch-repo',
        { repoName: 'landing', private: true, token: 'gho_secret' },
        { fetchImpl: fetchImpl as unknown as typeof fetch, exec },
      ),
    ).rejects.toMatchObject({
      code: 'SAVE_FAILED',
      message: 'Push failed: fatal: could not read Username',
    });
  });

  function repoCreated(fetchImpl = vi.fn()) {
    return fetchImpl
      .mockResolvedValueOnce(ok({ login: 'me', id: 7 }))
      .mockResolvedValueOnce(
        ok({ full_name: 'me/landing', clone_url: 'https://github.com/me/landing.git', html_url: 'https://github.com/me/landing' }, 201),
      );
  }

  it.each(['http.https://github.com.proxy', 'url.http://evil/.insteadof', 'credential.helper', 'include.path', 'includeif.gitdir:/.path'])(
    'a bare copy whose config carries %s fails SAVE_FAILED WITHOUT pushing',
    async (key) => {
      const gitCalls: GitCall[] = [];
      const exec = makeExec(gitCalls, { bareConfig: `core.bare\n${key}\n` });
      await expect(
        saveToGithub('/tmp/fake-scratch-repo', { repoName: 'landing', private: true, token: 'gho_secret' }, {
          fetchImpl: repoCreated() as unknown as typeof fetch,
          exec,
        }),
      ).rejects.toMatchObject({ code: 'SAVE_FAILED' });
      expect(gitCalls.some((c) => c.args.includes('push'))).toBe(false);
    },
  );

  it('sets the upstream for the CURRENT branch (still pushes HEAD:main)', async () => {
    const gitCalls: GitCall[] = [];
    const exec = makeExec(gitCalls, { branch: 'feature/x' });
    await saveToGithub('/tmp/fake-scratch-repo', { repoName: 'landing', private: true, token: 'gho_secret' }, {
      fetchImpl: repoCreated() as unknown as typeof fetch,
      exec,
    });
    const rest = gitCalls.map((c) => c.args.join(' '));
    expect(rest).toContain('-C /tmp/fake-scratch-repo config branch.feature/x.remote origin');
    expect(rest).toContain('-C /tmp/fake-scratch-repo config branch.feature/x.merge refs/heads/main');
    expect(gitCalls.find((c) => c.args.includes('push'))!.args.at(-1)).toBe('HEAD:main');
  });

  it('a detached HEAD skips the upstream config instead of failing', async () => {
    const gitCalls: GitCall[] = [];
    const exec = makeExec(gitCalls, {
      failOn: (args) => (args.includes('symbolic-ref') ? new Error('fatal: ref HEAD is not a symbolic ref') : undefined),
    });
    await saveToGithub('/tmp/fake-scratch-repo', { repoName: 'landing', private: true, token: 'gho_secret' }, {
      fetchImpl: repoCreated() as unknown as typeof fetch,
      exec,
    });
    expect(gitCalls.some((c) => c.args.join(' ').includes('config branch.'))).toBe(false);
    expect(gitCalls.some((c) => c.args.includes('push'))).toBe(true);
  });
});
