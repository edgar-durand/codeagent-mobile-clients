import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nonInteractiveGitEnv } from '../commands/host/workspace';
import { pushCleanCopy } from './push-clean';

const GL = 'https://gitlab.com/api/v4';

export interface SaveToGitlabResult {
  repoFullName: string;
  htmlUrl: string;
}

export interface SaveToGitlabInput {
  repoName: string;
  private: boolean;
  /** The user's GitLab OAuth access token (Agent Toolkit integration). */
  token: string;
}

export interface SaveToGitlabDeps {
  fetchImpl?: typeof fetch;
  exec?: typeof execFile;
}

/**
 * `scratch_save_gitlab` — creates the GitLab project for a "Start from scratch"
 * workspace under the user's account, commits pending changes, and pushes from
 * a clean bare copy (see `push-clean.ts`). GitLab takes an OAuth token over git
 * HTTPS as basic auth with the `oauth2` user — delivered as an env-configured
 * header, never in the URL.
 */
export async function saveToGitlab(
  cwd: string,
  input: SaveToGitlabInput,
  deps: SaveToGitlabDeps = {},
): Promise<SaveToGitlabResult> {
  const f = deps.fetchImpl ?? fetch;
  const exec = promisify(deps.exec ?? execFile);
  const headers = { Authorization: `Bearer ${input.token}`, 'User-Agent': 'codeam-cli' };
  const env = { ...process.env, ...nonInteractiveGitEnv() };
  const git = (...args: string[]) => exec('git', ['-C', cwd, ...args], { env });

  const meRes = await f(`${GL}/user`, { headers });
  const meBody = (await meRes.json()) as { username?: unknown; id?: unknown };
  if (!meRes.ok || typeof meBody.username !== 'string' || typeof meBody.id !== 'number') {
    throw Object.assign(new Error('GitLab rejected the token — reconnect GitLab and try again.'), {
      code: 'SAVE_FAILED',
    });
  }
  const me = { username: meBody.username, id: meBody.id };
  await git('config', 'user.name', me.username);
  await git('config', 'user.email', `${me.id}-${me.username}@users.noreply.gitlab.com`);
  const { stdout } = await git('status', '--porcelain');
  if (stdout.trim()) {
    await git('add', '-A');
    await git('commit', '-m', 'Save project from CodeAgent');
  }

  const res = await f(`${GL}/projects`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: input.repoName,
      path: input.repoName,
      visibility: input.private ? 'private' : 'public',
      initialize_with_readme: false,
    }),
  });
  const body = (await res.json()) as {
    path_with_namespace?: string;
    http_url_to_repo?: string;
    web_url?: string;
    message?: unknown;
  };
  if (res.status === 400 && /already been taken/i.test(JSON.stringify(body.message ?? ''))) {
    throw Object.assign(new Error('A project with that name already exists.'), {
      code: 'REPO_NAME_TAKEN',
    });
  }
  if (!res.ok || !body.path_with_namespace || !body.http_url_to_repo) {
    throw Object.assign(new Error(`GitLab answered ${res.status}`), { code: 'SAVE_FAILED' });
  }

  // The working repo tracks the new project (plain config, no token) so
  // later, normal pushes just work. A detached HEAD has no branch to track.
  await git('remote', 'remove', 'origin').catch(() => undefined);
  await git('remote', 'add', 'origin', body.http_url_to_repo);
  const branch = await git('symbolic-ref', '-q', '--short', 'HEAD').then(
    (r) => r.stdout.trim(),
    () => '',
  );
  if (branch) {
    await git('config', `branch.${branch}.remote`, 'origin');
    await git('config', `branch.${branch}.merge`, 'refs/heads/main');
  }

  await pushCleanCopy(
    cwd,
    body.http_url_to_repo,
    `basic ${Buffer.from(`oauth2:${input.token}`).toString('base64')}`,
    {
      exec: deps.exec,
      env,
    },
  );

  return {
    repoFullName: body.path_with_namespace,
    htmlUrl: body.web_url ?? `https://gitlab.com/${body.path_with_namespace}`,
  };
}
