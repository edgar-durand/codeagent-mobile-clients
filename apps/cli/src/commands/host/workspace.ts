/**
 * Self-hosted host-agent — workspace preparation for a deploy.
 *
 * Design of record:
 * docs/superpowers/specs/2026-06-17-self-hosted-execution-plane-design.md
 *
 * `repoOrPath` from a `self_hosted_deploy` is either:
 *   - an ABSOLUTE PATH on the box → used in place (the user points at a
 *     checkout they already have), or
 *   - a GitHub repo ref (`owner/repo` or a clone URL) → cloned under
 *     `~/.codeam/self-hosted/<deployId>`.
 *
 * Clone auth: when the deploy command carries a short-lived `cloneToken`
 * (a GitHub token minted by the backend) AND the target is a GitHub repo,
 * we clone via `https://x-access-token:<token>@github.com/owner/repo.git`
 * so private repos the box couldn't otherwise read clone cleanly. With no
 * token we fall back to the box's ambient git auth.
 *
 * In ALL cases git runs with `GIT_TERMINAL_PROMPT=0` (and friends) so a
 * missing or invalid credential FAILS FAST instead of hanging forever on
 * an interactive credential prompt — the original "deploy hangs silently"
 * bug. The token is NEVER logged: any thrown error has the token-bearing
 * URL masked before it propagates.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { restrictToOwner } from '../../lib/restrict-to-owner';

const execFileP = promisify(execFile);

/** True when `target` looks like an absolute filesystem path. */
export function isAbsolutePathTarget(target: string): boolean {
  return path.isAbsolute(target);
}

/** Root for host-agent-managed clones: `~/.codeam/self-hosted`. */
export function selfHostedWorkspaceRoot(): string {
  return path.join(os.homedir(), '.codeam', 'self-hosted');
}

/**
 * Non-interactive git environment: never prompt for credentials on the
 * terminal, never invoke an askpass helper, never pop a Git Credential
 * Manager dialog. A missing/invalid credential therefore fails fast with a
 * non-zero exit instead of hanging the deploy waiting on stdin.
 */
function nonInteractiveGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
  };
}

/** Parse a GitHub `owner/repo` out of a ref or URL; null if not GitHub. */
function githubOwnerRepo(repoRef: string): { owner: string; repo: string } | null {
  const trimmed = repoRef.trim();
  // owner/repo shorthand (no scheme, no host).
  const shorthand = /^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(trimmed);
  if (shorthand && !/^https?:\/\//.test(trimmed) && !trimmed.startsWith('git@')) {
    return { owner: shorthand[1], repo: shorthand[2] };
  }
  // https://github.com/owner/repo(.git) URL form.
  const httpsMatch = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  return null;
}

/** The code host a `repoOrPath` repo lives on. */
export type RepoProvider = 'github' | 'gitlab';

/** Parse a GitLab project PATH (nested groups allowed) out of a ref or URL;
 *  null if it doesn't look like a gitlab.com target. */
function gitlabProjectPath(repoRef: string): string | null {
  const trimmed = repoRef.trim();
  const https = /^https?:\/\/gitlab\.com\/(.+?)(?:\.git)?\/?$/.exec(trimmed);
  if (https) return https[1];
  // `group/sub/project` shorthand (>= 2 segments, no scheme/host).
  if (!/^https?:\/\//.test(trimmed) && !trimmed.startsWith('git@') && trimmed.includes('/')) {
    return trimmed.replace(/\.git$/, '');
  }
  return null;
}

/**
 * Normalise an `owner/repo` (GitHub) or `group/sub/project` (GitLab) ref into
 * an https clone URL. When a `cloneToken` is supplied it's embedded so a
 * private repo clones cleanly — as `x-access-token:<t>@github.com` for GitHub,
 * `oauth2:<t>@gitlab.com` for GitLab (GitLab's documented OAuth clone form).
 */
export function repoCloneUrl(
  repoRef: string,
  cloneToken?: string,
  provider: RepoProvider = 'github',
): string {
  const trimmed = repoRef.trim();
  if (provider === 'gitlab') {
    const glPath = gitlabProjectPath(trimmed);
    if (glPath) {
      return cloneToken
        ? `https://oauth2:${cloneToken}@gitlab.com/${glPath}.git`
        : `https://gitlab.com/${glPath}.git`;
    }
    if (/^https?:\/\//.test(trimmed) || trimmed.startsWith('git@')) return trimmed;
  }
  if (cloneToken) {
    const gh = githubOwnerRepo(trimmed);
    if (gh) {
      return `https://x-access-token:${cloneToken}@github.com/${gh.owner}/${gh.repo}.git`;
    }
  }
  if (/^https?:\/\//.test(trimmed) || trimmed.startsWith('git@')) return trimmed;
  // `owner/repo` shorthand.
  return `https://github.com/${trimmed.replace(/\.git$/, '')}.git`;
}

/** Mask a token-bearing clone URL so it never reaches a log or error message. */
function maskCloneUrl(url: string): string {
  return url.replace(/(https?:\/\/)[^@/]+@/, '$1***@');
}

/**
 * Configure a workspace-LOCAL git credential helper so the agent's later
 * `git pull` / `git push` authenticate the same way the clone did.
 *
 * Why this exists: previously the only auth was the `cloneToken` embedded in
 * the `origin` remote URL. Git persists that URL (token and all) into
 * `.git/config`, so push/pull "worked" only until the short-lived token
 * expired — after which the agent hit "access denied" mid-session (the bug a
 * user lost an interview over). It also left the token sitting as a stale
 * secret in `.git/config`.
 *
 * The fix points git at a credentials file inside `<dest>/.git/` (mode 0600,
 * never pushed) via a **repo-local** `credential.helper store` — scoped to this
 * workspace, so it does NOT pollute the user's global `~/.gitconfig` /
 * `~/.git-credentials` on their own box. The token is then STRIPPED from the
 * `origin` URL so nothing logs or persists it there; the helper supplies it.
 * Re-running (a re-deploy) refreshes the stored token in place.
 *
 * No-op for non-GitHub remotes — we leave the box's ambient git auth alone.
 */
/**
 * Resolve the user's GitHub login + primary email from a token (best-effort).
 * Returns null on any failure (network down, non-user/installation token, etc.)
 * — callers must treat the identity as optional.
 */
async function fetchGithubIdentity(
  token: string,
): Promise<{ login?: string; email?: string } | null> {
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'codeam-cli',
        Accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { login?: string; email?: string | null };
    return { login: body.login, email: body.email ?? undefined };
  } catch {
    return null;
  }
}

export async function configureGitCredentials(
  dest: string,
  repoRef: string,
  cloneToken: string,
  provider: RepoProvider = 'github',
): Promise<void> {
  const isGitlab = provider === 'gitlab';
  // Only proceed for a recognised repo target of this provider.
  if (isGitlab ? !gitlabProjectPath(repoRef.trim()) : !githubOwnerRepo(repoRef.trim())) return;
  if (!cloneToken) return;

  const credFile = path.join(dest, '.git', 'codeam-credentials');
  // 0600 credentials file holding the token, inside .git (never committed/pushed).
  // GitLab clones over HTTPS as `oauth2:<token>`; GitHub as `x-access-token:<token>`.
  const credLine = isGitlab
    ? `https://oauth2:${cloneToken}@gitlab.com\n`
    : `https://x-access-token:${cloneToken}@github.com\n`;
  fs.writeFileSync(credFile, credLine, { mode: 0o600 });
  restrictToOwner(credFile);

  const env = nonInteractiveGitEnv();
  const git = (args: string[]): Promise<unknown> =>
    execFileP('git', ['-C', dest, ...args], { timeout: 30_000, env });

  // Reset this repo's helper chain, then point it at our scoped store file.
  // An empty value clears any inherited helper so OURS is authoritative here.
  // Use a FORWARD-SLASH path: git config treats backslashes as escapes, so a
  // Windows path (`C:\Users\…`) in `--file=` is mangled and the store helper
  // silently can't find the file (git then prompts and push/pull fail). Git
  // accepts forward slashes on every OS, so this is the OS-agnostic form.
  const credFilePosix = credFile.split(path.sep).join('/');
  await git(['config', '--local', '--replace-all', 'credential.helper', '']).catch(() => {});
  await git([
    'config',
    '--local',
    '--add',
    'credential.helper',
    `store --file=${credFilePosix}`,
  ]).catch(() => {});
  // Strip the token from the remote URL — the helper supplies it now, and the
  // remote should never carry a secret that ends up in logs / `git remote -v`.
  await git(['remote', 'set-url', 'origin', repoCloneUrl(repoRef, undefined, provider)]).catch(() => {});

  // Commit identity: without user.name/user.email, `git commit` aborts ("Please
  // tell me who you are"), so the agent's push would have nothing to send. Set
  // it LOCALLY and ONLY when the box has no identity at all — never clobber the
  // user's own global git identity on their own machine.
  const hasIdentity = await git(['config', 'user.email'])
    .then(() => true)
    .catch(() => false);
  if (!hasIdentity) {
    const who = isGitlab ? null : await fetchGithubIdentity(cloneToken);
    const login = who?.login ?? 'CodeAgent';
    await git(['config', '--local', 'user.name', login]).catch(() => {});
    const email =
      who?.email ??
      (isGitlab ? 'agent@codeagent-mobile.com' : `${login}@users.noreply.github.com`);
    await git(['config', '--local', 'user.email', email]).catch(() => {});
  }
}

/** Mask any embedded token in an arbitrary string (defensive, for error text). */
function maskToken(text: string, cloneToken?: string): string {
  const masked = maskCloneUrl(text);
  if (cloneToken && cloneToken.length > 0) {
    return masked.split(cloneToken).join('***');
  }
  return masked;
}

/**
 * Resolve the working directory for a deploy. Clones the repo when
 * `repoOrPath` is a repo ref; returns the path verbatim when it is an
 * absolute path. Idempotent for clones: a pre-existing target dir for
 * the same `deployId` is reused rather than re-cloned.
 *
 * When `cloneToken` is present and the target is a GitHub repo, the clone
 * authenticates with it (private-repo support). The clone always runs
 * non-interactively (see `nonInteractiveGitEnv`) so it can never hang, and
 * the token is masked out of any error it throws.
 */
export async function prepareWorkspace(
  repoOrPath: string,
  deployId: string,
  cloneToken?: string,
  provider: RepoProvider = 'github',
  branch?: string,
): Promise<string> {
  if (isAbsolutePathTarget(repoOrPath)) {
    if (!fs.existsSync(repoOrPath)) {
      throw new Error(`deploy target path does not exist: ${repoOrPath}`);
    }
    return repoOrPath;
  }

  const dest = path.join(selfHostedWorkspaceRoot(), deployId);
  if (fs.existsSync(path.join(dest, '.git'))) {
    // Already cloned for this deploy — refresh the scoped credential helper so a
    // re-deploy picks up a newer token and push/pull keep working.
    if (cloneToken) await configureGitCredentials(dest, repoOrPath, cloneToken, provider);
    return dest;
  }
  fs.mkdirSync(selfHostedWorkspaceRoot(), { recursive: true, mode: 0o700 });
  const cloneUrl = repoCloneUrl(repoOrPath, cloneToken, provider);
  // A specific branch (e.g. a PR head branch for an agent review) is a shallow
  // single-branch clone; absent ⇒ the repo's default branch. `--branch` accepts a
  // branch name or tag; a bad ref surfaces as the clone error below.
  const cloneArgs = branch
    ? ['clone', '--depth', '1', '--branch', branch, cloneUrl, dest]
    : ['clone', '--depth', '1', cloneUrl, dest];
  try {
    await execFileP('git', cloneArgs, {
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      env: nonInteractiveGitEnv(),
    });
  } catch (err) {
    // Re-throw with the token-bearing URL masked so nothing logs the token.
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`git clone failed for ${maskCloneUrl(cloneUrl)}: ${maskToken(reason, cloneToken)}`);
  }
  // Install a persistent, workspace-local git credential helper so the agent's
  // later `git pull` / `git push` authenticate even after the token would have
  // expired from the (now stripped) remote URL — the "access denied" fix.
  if (cloneToken) await configureGitCredentials(dest, repoOrPath, cloneToken, provider);
  return dest;
}
