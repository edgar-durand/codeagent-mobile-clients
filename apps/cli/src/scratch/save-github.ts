import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nonInteractiveGitEnv } from '../commands/host/workspace';

const GH = 'https://api.github.com';

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
 * pushes with the token delivered ONLY as an env-configured HTTP header on
 * the push child (never argv, never a URL, never a credential helper) so it
 * can't leak into `.git/config`, `ps` or a helper. Throws an
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
  // The token reaches git ONLY as an HTTP Authorization header, set through
  // git's env-config (GIT_CONFIG_*) in the push child's env alone: never
  // argv, never a URL, and never the credential subsystem — so no credential
  // helper (whatever the agent wrote into `.git/config`) can be handed it on
  // fill/store/erase. config/status/add/commit (which may run repo hooks) get
  // the plain env; the push itself runs no hooks at all.
  const env = { ...process.env, ...nonInteractiveGitEnv() };
  const git = (...args: string[]) => exec('git', ['-C', cwd, ...args], { env });

  const meRes = await f(`${GH}/user`, { headers });
  const meBody = (await meRes.json()) as { login?: unknown; id?: unknown };
  if (!meRes.ok || typeof meBody.login !== 'string' || typeof meBody.id !== 'number') {
    throw Object.assign(
      new Error('GitHub rejected the token — reconnect GitHub and try again.'),
      { code: 'SAVE_FAILED' },
    );
  }
  const me = { login: meBody.login, id: meBody.id };
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
  const pushEnv = {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_COUNT: '1',
    // Scoped to this exact repo URL: the header goes nowhere else.
    GIT_CONFIG_KEY_0: `http.${body.clone_url}.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${input.token}`).toString('base64')}`,
  };
  await exec(
    'git',
    [
      '-C',
      cwd,
      // Empties the helper list (URL-scoped entries included) and never
      // prompts: the header is the only way this push authenticates.
      '-c',
      'credential.helper=',
      '-c',
      'credential.interactive=never',
      '-c',
      'core.hooksPath=/dev/null',
      'push',
      '-u',
      'origin',
      'HEAD:main',
    ],
    { env: pushEnv },
  ).catch((err) => {
    throw Object.assign(new Error(`Push failed: ${(err as Error).message.split('\n')[0]}`), {
      code: 'SAVE_FAILED',
    });
  });
  return { repoFullName: body.full_name, htmlUrl: body.html_url ?? `https://github.com/${body.full_name}` };
}
