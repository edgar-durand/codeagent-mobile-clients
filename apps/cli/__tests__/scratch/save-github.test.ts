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
  opts: { statusOutput?: string; failOn?: (args: string[]) => Error | undefined } = {},
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

    // The push carries the token ONLY in env, never in argv.
    const push = gitCalls.find((c) => c.args.includes('push'))!;
    expect(push.args).toEqual([
      '-C',
      dir,
      '-c',
      'credential.helper=',
      '-c',
      expect.stringContaining('credential.helper=!f'),
      // No repo hook (pre-push, …) ever runs while CODEAM_GH_TOKEN is in env.
      '-c',
      'core.hooksPath=/dev/null',
      'push',
      '-u',
      'origin',
      'HEAD:main',
    ]);
    expect(push.args.join(' ')).not.toContain('gho_secret');
    expect(push.env.CODEAM_GH_TOKEN).toBe('gho_secret');

    // The secret never leaks into ANY git argv, not just the push.
    for (const call of gitCalls) {
      expect(call.args.join(' ')).not.toContain('gho_secret');
    }

    // ONLY the push call's env carries the token — config/status/add/commit/
    // remote run under the plain env, since a repo hook running on `commit`
    // (or any other non-push call) has no business seeing it.
    for (const call of gitCalls) {
      if (call.args.includes('push')) continue;
      expect(call.env.CODEAM_GH_TOKEN).toBeUndefined();
    }
    expect(gitCalls.filter((c) => c.env.CODEAM_GH_TOKEN === 'gho_secret')).toHaveLength(1);
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
});
