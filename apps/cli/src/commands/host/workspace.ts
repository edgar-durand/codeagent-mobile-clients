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
 *     `~/.codeam/self-hosted/<deployId>` using the box's own git auth.
 *
 * The clone uses the box's ambient git credentials (the user enrolled
 * the box from a laptop SSH session they already trust). The backend
 * deploy command does not (yet) carry a short-lived clone token — see
 * the Phase-3 note in host-agent.ts for closing that gap on private
 * repos the box can't otherwise read.
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

/** Normalise an `owner/repo` (or URL) ref into an https clone URL. */
export function repoCloneUrl(repoRef: string): string {
  const trimmed = repoRef.trim();
  if (/^https?:\/\//.test(trimmed) || trimmed.startsWith('git@')) return trimmed;
  // `owner/repo` shorthand.
  return `https://github.com/${trimmed.replace(/\.git$/, '')}.git`;
}

/**
 * Resolve the working directory for a deploy. Clones the repo when
 * `repoOrPath` is a repo ref; returns the path verbatim when it is an
 * absolute path. Idempotent for clones: a pre-existing target dir for
 * the same `deployId` is reused rather than re-cloned.
 */
export async function prepareWorkspace(
  repoOrPath: string,
  deployId: string,
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
  await execFileP('git', ['clone', '--depth', '1', repoCloneUrl(repoOrPath), dest], {
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return dest;
}
