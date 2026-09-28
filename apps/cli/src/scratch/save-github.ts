import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nonInteractiveGitEnv } from '../commands/host/workspace';

const GH = 'https://api.github.com';
// The token is delivered ONLY via `CODEAM_GH_TOKEN` in the child's env (never
// argv/URL) — this helper reads it back out of ITS OWN env at push time, so
// `ps` on the box never shows the secret.
const HELPER = '!f() { echo username=x-access-token; echo "password=${CODEAM_GH_TOKEN}"; }; f';

export interface SaveToGithubResult {
  repoFullName: string;
  htmlUrl: string;
}

export interface SaveToGithubInput {
  repoName: string;
  private: boolean;
  token: string;
}

export interface SaveToGithubDeps {
  fetchImpl?: typeof fetch;
  exec?: typeof execFile;
}

/**
 * `scratch_save_github` — creates the GitHub repo for a "Start from scratch"
 * project, commits any pending changes with the user's own identity, and
 * pushes with the token delivered ONLY via the child process's env (never
 * argv, never a URL) so it can't leak into `.git/config` or `ps`. Throws an
 * `Error` with `.code === 'REPO_NAME_TAKEN' | 'SAVE_FAILED'` on failure.
 */
export async function saveToGithub(
  cwd: string,
  input: SaveToGithubInput,
  deps: SaveToGithubDeps = {},
): Promise<SaveToGithubResult> {
  const f = deps.fetchImpl ?? fetch;
  const exec = promisify(deps.exec ?? execFile);
  const headers = {
    Authorization: `Bearer ${input.token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'codeam-cli',
  };
  const env = { ...process.env, ...nonInteractiveGitEnv(), CODEAM_GH_TOKEN: input.token };
  const git = (...args: string[]) => exec('git', ['-C', cwd, ...args], { env });

  const me = (await (await f(`${GH}/user`, { headers })).json()) as { login: string; id: number };
  await git('config', 'user.name', me.login);
  await git('config', 'user.email', `${me.id}+${me.login}@users.noreply.github.com`);
  const { stdout } = await git('status', '--porcelain');
  if (stdout.trim()) {
    await git('add', '-A');
    await git('commit', '-m', 'Save project from CodeAgent');
  }

  const res = await f(`${GH}/user/repos`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: input.repoName, private: input.private, auto_init: false }),
  });
  const body = (await res.json()) as {
    full_name?: string;
    clone_url?: string;
    html_url?: string;
    errors?: Array<{ message?: string }>;
  };
  if (res.status === 422 && body.errors?.some((e) => /already exists/i.test(e.message ?? ''))) {
    throw Object.assign(new Error('A repository with that name already exists.'), {
      code: 'REPO_NAME_TAKEN',
    });
  }
  if (!res.ok || !body.full_name || !body.clone_url) {
    throw Object.assign(new Error(`GitHub answered ${res.status}`), { code: 'SAVE_FAILED' });
  }

  await git('remote', 'remove', 'origin').catch(() => undefined);
  await git('remote', 'add', 'origin', body.clone_url);
  await exec(
    'git',
    [
      '-C',
      cwd,
      '-c',
      'credential.helper=',
      '-c',
      `credential.helper=${HELPER}`,
      'push',
      '-u',
      'origin',
      'HEAD:main',
    ],
    { env },
  ).catch((err) => {
    throw Object.assign(new Error(`Push failed: ${(err as Error).message.split('\n')[0]}`), {
      code: 'SAVE_FAILED',
    });
  });
  return { repoFullName: body.full_name, htmlUrl: body.html_url ?? `https://github.com/${body.full_name}` };
}
