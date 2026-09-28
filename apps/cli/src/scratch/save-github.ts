import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
 * pushes FROM A CLEAN BARE COPY with the token delivered ONLY as an
 * env-configured HTTP header on the push child (never argv, never a URL,
 * never a credential helper), so nothing the agent wrote into the working
 * repo's config (proxy, TLS, helpers, hooks) can capture it. Throws an
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
  // The working repo's `.git/config` is agent-writable (proxy, sslVerify,
  // credential helpers, hooks, …), so the token-carrying push never runs
  // there: it runs from a fresh bare clone whose config the agent never
  // touched, with no system/global config and a throwaway HOME. The token
  // reaches git ONLY as an HTTP Authorization header, set through git's
  // env-config (GIT_CONFIG_*) in the push child's env alone — never argv,
  // never a URL, never the credential subsystem. config/status/add/commit
  // (which may run repo hooks) get the plain env.
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

  // The working repo tracks the new repo (set before the push, as the repo
  // already exists on GitHub either way) so later, normal pushes just work.
  // Plain config: no token is involved here.
  await git('remote', 'remove', 'origin').catch(() => undefined);
  await git('remote', 'add', 'origin', body.clone_url);
  await git('config', 'branch.main.remote', 'origin');
  await git('config', 'branch.main.merge', 'refs/heads/main');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-push-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-push-home-'));
  try {
    const bare = path.join(tmp, 'repo.git');
    await exec('git', ['clone', '--bare', '--no-hardlinks', '-q', cwd, bare], { env });
    const pushEnv = {
      ...env,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
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
        bare,
        '-c',
        'credential.helper=',
        '-c',
        'credential.interactive=never',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'http.sslVerify=true',
        '-c',
        'http.proxy=',
        'push',
        body.clone_url,
        'HEAD:main',
      ],
      { env: pushEnv },
    );
  } catch (err) {
    throw Object.assign(new Error(`Push failed: ${(err as Error).message.split('\n')[0]}`), {
      code: 'SAVE_FAILED',
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }

  return { repoFullName: body.full_name, htmlUrl: body.html_url ?? `https://github.com/${body.full_name}` };
}
