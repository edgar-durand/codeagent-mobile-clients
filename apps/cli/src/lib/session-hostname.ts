import * as os from 'os';
import * as path from 'path';
import { execFileSync, type ExecFileSyncOptions } from 'child_process';

/**
 * Name of the wrapper repo every GitHub Codespace is created on since the
 * 2026-07-24 prebaked-image strategy. Its checkout lives alongside the
 * user's cloned repo under `/workspaces/`, so a directory-name fallback
 * MUST skip it — otherwise every codespace would be labelled
 * "codeam-codespace" instead of the user's project.
 */
const WRAPPER_REPO_NAME = 'codeam-codespace';

/**
 * Hostname/label the CLI reports to the backend for a paired session.
 *
 * On a local or self-hosted box this is `os.hostname()` — the machine name
 * is exactly what the user expects to see, and it is unique per box.
 *
 * Inside a GitHub Codespace it is NOT. Since every codespace is created on
 * OUR wrapper repo (`CodeAgentMobile/codeam-codespace`), GitHub derives the
 * container hostname from that repo, so EVERY user's every codespace reports
 * the SAME string (observed live: `codespaces-496218` across 2 accounts, 3
 * codespaces and 2 repos). Users then cannot tell their sessions apart.
 *
 * So in a codespace we report the USER's repo instead — `owner/repo` from the
 * git remote when available, else the checkout directory name. The pair-auto
 * daemon's cwd is the user's cloned repo (`/workspaces/<repo>`), which is what
 * makes this cheap and correct.
 *
 * The git call is SYNCHRONOUS but runs at most ONCE per process (memoised
 * below) and only on the pairing path — never on the 20 s heartbeat tick.
 */
export function resolveSessionHostname(cwd: string = process.cwd()): string {
  if (process.env.CODESPACES !== 'true') return _osSeam.hostname();
  return codespaceSessionLabel(cwd) ?? _osSeam.hostname();
}

/**
 * Seam for `os.hostname()`. `os` is an ESM namespace under vitest so it
 * cannot be spied on directly; this keeps the machine-name branch testable.
 */
export const _osSeam = {
  hostname: (): string => os.hostname(),
};

let memo: { cwd: string; label: string | null } | undefined;

/**
 * Repo-derived label for a codespace session, or `null` when nothing better
 * than the hostname can be determined. Memoised on `cwd` so repeated pairing
 * attempts (the `requestCode` retry loop) don't re-spawn git.
 */
export function codespaceSessionLabel(cwd: string = process.cwd()): string | null {
  if (memo && memo.cwd === cwd) return memo.label;
  const label = computeCodespaceSessionLabel(cwd);
  memo = { cwd, label };
  return label;
}

function computeCodespaceSessionLabel(cwd: string): string | null {
  const fromRemote = repoFromGitRemote(cwd);
  if (fromRemote) return fromRemote;

  // Remote-less repo (or git unavailable): the checkout directory name is
  // still far more identifying than the shared codespaces-<hash> hostname.
  const base = path.basename(path.resolve(cwd));
  if (!base || base === WRAPPER_REPO_NAME || base === 'workspaces' || base === '/') return null;
  return base;
}

function repoFromGitRemote(cwd: string): string | null {
  try {
    const raw = _execSeam.exec('git', ['remote', 'get-url', 'origin'], {
      cwd,
      // Same 1 s ceiling as `detectCurrentBranch` — comfortably above normal
      // git latency and well below the pair POST's own timeout budget.
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    return normalizeRepoIdentifier(raw);
  } catch {
    return null;
  }
}

/**
 * Turn any git remote URL into `owner/repo`.
 *
 * Handles `https://host/owner/repo(.git)`, `git@host:owner/repo(.git)`,
 * `ssh://git@host/owner/repo(.git)` and — critically — URLs carrying embedded
 * credentials (`https://x-access-token:<TOKEN>@github.com/owner/repo.git`).
 * The userinfo segment is dropped BEFORE anything is returned so a clone
 * token can never end up in a session label we ship to the backend.
 */
export function normalizeRepoIdentifier(remoteUrl: string): string | null {
  let url = remoteUrl.trim();
  if (!url) return null;

  // scp-like syntax: git@host:owner/repo.git → host/owner/repo.git
  url = url.replace(/^[^/]*@([^:/]+):/, '$1/');
  // scheme
  url = url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  // SEC: strip any `user:password@` userinfo before it can be surfaced.
  url = url.replace(/^[^/]*@/, '');
  url = url.replace(/\.git$/, '').replace(/\/+$/, '');

  const parts = url.split('/').filter(Boolean);
  if (parts.length < 3) return null; // need host + owner + repo
  const repo = parts[parts.length - 1];
  const owner = parts[parts.length - 2];
  if (!repo || !owner) return null;
  return `${owner}/${repo}`;
}

/**
 * Indirection layer so tests can stub the git call without a
 * `vi.mock('child_process')` that would touch every other module.
 * Mirrors the seam in `git-branch.ts`.
 */
export const _execSeam = {
  exec: (file: string, args: readonly string[], opts: ExecFileSyncOptions): string => {
    const out = execFileSync(file, args, opts);
    return typeof out === 'string' ? out : out.toString('utf8');
  },
};

/** Test-only: drop the memoised label so each case starts clean. */
export function _resetSessionHostnameCache(): void {
  memo = undefined;
}
