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

/**
 * Normalise an `owner/repo` (or URL) ref into an https clone URL. When a
 * `cloneToken` is supplied and the target is a GitHub repo, the token is
 * embedded as `x-access-token:<token>` so the clone authenticates.
 */
export function repoCloneUrl(repoRef: string, cloneToken?: string): string {
  const trimmed = repoRef.trim();
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
): Promise<string> {
  if (isAbsolutePathTarget(repoOrPath)) {
    if (!fs.existsSync(repoOrPath)) {
      throw new Error(`deploy target path does not exist: ${repoOrPath}`);
    }
    return repoOrPath;
  }

  const dest = path.join(selfHostedWorkspaceRoot(), deployId);
  if (fs.existsSync(path.join(dest, '.git'))) {
    return dest; // already cloned for this deploy
  }
  fs.mkdirSync(selfHostedWorkspaceRoot(), { recursive: true, mode: 0o700 });
  const cloneUrl = repoCloneUrl(repoOrPath, cloneToken);
  try {
    await execFileP('git', ['clone', '--depth', '1', cloneUrl, dest], {
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      env: nonInteractiveGitEnv(),
    });
  } catch (err) {
    // Re-throw with the token-bearing URL masked so nothing logs the token.
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`git clone failed for ${maskCloneUrl(cloneUrl)}: ${maskToken(reason, cloneToken)}`);
  }
  return dest;
}
