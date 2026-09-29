import { describe, expect, it, vi } from 'vitest';
import { promisify } from 'node:util';
import type { execFile as ExecFileType } from 'node:child_process';
import { saveToGitlab } from '../../src/scratch/save-gitlab';

const GL = 'https://gitlab.com/api/v4';

interface GitCall {
  args: string[];
  env: NodeJS.ProcessEnv;
}

function ok(
  body: unknown,
  status = 200,
): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: status < 300, status, json: () => Promise.resolve(body) };
}

function makeExec(calls: GitCall[], opts: { statusOutput?: string } = {}): typeof ExecFileType {
  const fn = (() => {
    throw new Error('unexpected direct call');
  }) as unknown as typeof ExecFileType;
  Object.defineProperty(fn, promisify.custom, {
    value: async (_file: string, args: string[], execOpts: { env: NodeJS.ProcessEnv }) => {
      calls.push({ args, env: execOpts.env });
      if (args.includes('status')) return { stdout: opts.statusOutput ?? '', stderr: '' };
      if (args.includes('symbolic-ref')) return { stdout: 'main\n', stderr: '' };
      if (args.includes('--name-only'))
        return { stdout: 'core.bare\nremote.origin.url\n', stderr: '' };
      return { stdout: '', stderr: '' };
    },
  });
  return fn;
}

describe('saveToGitlab', () => {
  it('creates the project under the user, commits pending changes, pushes with oauth2 basic auth ONLY in env', async () => {
    const gitCalls: GitCall[] = [];
    const exec = makeExec(gitCalls, { statusOutput: ' M index.html\n' });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok({ username: 'me', id: 7 }))
      .mockResolvedValueOnce(
        ok(
          {
            path_with_namespace: 'me/bruma',
            http_url_to_repo: 'https://gitlab.com/me/bruma.git',
            web_url: 'https://gitlab.com/me/bruma',
          },
          201,
        ),
      );

    const res = await saveToGitlab(
      '/tmp/fake',
      { repoName: 'bruma', private: true, token: 'glpat-x' },
      { fetchImpl, exec },
    );

    expect(res).toEqual({ repoFullName: 'me/bruma', htmlUrl: 'https://gitlab.com/me/bruma' });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      `${GL}/user`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer glpat-x' }),
      }),
    );
    const create = fetchImpl.mock.calls[1];
    expect(create[0]).toBe(`${GL}/projects`);
    expect(JSON.parse(create[1].body)).toEqual({
      name: 'bruma',
      path: 'bruma',
      visibility: 'private',
      initialize_with_readme: false,
    });
    // identity + commit of pending changes
    expect(
      gitCalls.some((c) =>
        c.args.join(' ').includes('config user.email 7-me@users.noreply.gitlab.com'),
      ),
    ).toBe(true);
    expect(gitCalls.some((c) => c.args.includes('commit'))).toBe(true);
    // the push child carries the token as an env-configured header, never argv
    const push = gitCalls.find((c) => c.args.includes('push'));
    expect(push).toBeTruthy();
    expect(push!.args.join(' ')).not.toContain('glpat-x');
    expect(push!.env.GIT_CONFIG_KEY_0).toBe('http.https://gitlab.com/me/bruma.git.extraheader');
    expect(push!.env.GIT_CONFIG_VALUE_0).toBe(
      `AUTHORIZATION: basic ${Buffer.from('oauth2:glpat-x').toString('base64')}`,
    );
    expect(push!.args.slice(-2)).toEqual(['https://gitlab.com/me/bruma.git', 'HEAD:main']);
  });

  it('a public save asks for public visibility and no commit runs on a clean tree', async () => {
    const gitCalls: GitCall[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok({ username: 'me', id: 7 }))
      .mockResolvedValueOnce(
        ok({ path_with_namespace: 'me/x', http_url_to_repo: 'https://gitlab.com/me/x.git' }, 201),
      );
    await saveToGitlab(
      '/tmp/fake',
      { repoName: 'x', private: false, token: 't' },
      { fetchImpl, exec: makeExec(gitCalls) },
    );
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).visibility).toBe('public');
    expect(gitCalls.some((c) => c.args.includes('commit'))).toBe(false);
  });

  it('maps "has already been taken" to REPO_NAME_TAKEN and a bad token to SAVE_FAILED', async () => {
    const taken = vi
      .fn()
      .mockResolvedValueOnce(ok({ username: 'me', id: 7 }))
      .mockResolvedValueOnce(ok({ message: { name: ['has already been taken'] } }, 400));
    await expect(
      saveToGitlab(
        '/tmp/fake',
        { repoName: 'x', private: true, token: 't' },
        { fetchImpl: taken, exec: makeExec([]) },
      ),
    ).rejects.toMatchObject({ code: 'REPO_NAME_TAKEN' });
    const bad = vi.fn().mockResolvedValueOnce(ok({ message: '401 Unauthorized' }, 401));
    await expect(
      saveToGitlab(
        '/tmp/fake',
        { repoName: 'x', private: true, token: 't' },
        { fetchImpl: bad, exec: makeExec([]) },
      ),
    ).rejects.toMatchObject({ code: 'SAVE_FAILED' });
  });
});
