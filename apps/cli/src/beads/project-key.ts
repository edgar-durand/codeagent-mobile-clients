import { execFileSync, type ExecFileSyncOptions } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Derive the Beads `projectKey` (decision D7) for a working directory.
 *
 * Primary: the normalized git `origin` remote — `host/org/repo` with scheme,
 * embedded credentials, and a trailing `.git` stripped and the host lowercased.
 * Origin is stable across clones, machines, and devices, so the same project
 * resolves to the same key on a laptop and in a codespace — required for a
 * cross-repo, multi-device brain.
 *
 * Fallback (no remote — detached, local-only repo): `path:<sha256(realpath)>`
 * of the repo root, so a project still gets a stable per-machine key.
 *
 * Also returns a human `projectLabel` (the repo name) for the mobile/web UI.
 */
export interface ProjectIdentity {
  projectKey: string;
  projectLabel: string;
}

/**
 * Normalize a raw `git remote get-url origin` value into `host/org/repo`.
 * Handles the three url shapes git emits:
 *   - https://user:pass@github.com/org/repo.git
 *   - git@github.com:org/repo.git           (scp-like)
 *   - ssh://git@github.com:22/org/repo.git
 * Returns null when the input doesn't look like a remote we can normalize.
 */
export function normalizeOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let host: string;
  let pathPart: string;

  const scpLike = /^[^/@]+@([^:]+):(.+)$/.exec(trimmed);
  if (scpLike && !trimmed.includes('://')) {
    // git@github.com:org/repo.git
    host = scpLike[1];
    pathPart = scpLike[2];
  } else {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    host = url.hostname; // strips scheme + embedded credentials + port
    pathPart = url.pathname;
  }

  host = host.toLowerCase();
  pathPart = pathPart
    .replace(/^\/+/, '') // leading slashes
    .replace(/\.git$/i, '') // trailing .git
    .replace(/\/+$/, ''); // trailing slashes

  if (!host || !pathPart) return null;
  return `${host}/${pathPart}`;
}

/**
 * Resolve the repo root for `cwd` (walks up to the `.git`). Returns null when
 * `cwd` isn't inside a git repo. Pure-ish: uses fs.statSync walk so it doesn't
 * shell out for the common case.
 */
function findRepoRoot(cwd: string): string | null {
  let dir = path.resolve(cwd);
  const seen = new Set<string>();
  for (let i = 0; i < 256; i++) {
    if (seen.has(dir)) return null;
    seen.add(dir);
    try {
      const stat = fs.statSync(path.join(dir, '.git'), { throwIfNoEntry: false });
      if (stat && (stat.isDirectory() || stat.isFile())) return dir;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Test seam for the git origin lookup — mirrors `git-branch.ts`'s `_execSeam`
 * so tests can stub the remote without `vi.mock('child_process')`.
 */
export const _execSeam = {
  exec: (file: string, args: readonly string[], opts: ExecFileSyncOptions): string => {
    const out = execFileSync(file, args, opts);
    return typeof out === 'string' ? out : out.toString('utf8');
  },
  realpath: (p: string): string => fs.realpathSync(p),
};

function readOrigin(cwd: string): string | null {
  try {
    const raw = _execSeam.exec('git', ['remote', 'get-url', 'origin'], {
      cwd,
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    return raw.trim() || null;
  } catch {
    return null;
  }
}

export function deriveProjectIdentity(cwd: string = process.cwd()): ProjectIdentity {
  const repoRoot = findRepoRoot(cwd) ?? cwd;
  const origin = readOrigin(repoRoot);
  const normalized = origin ? normalizeOrigin(origin) : null;

  if (normalized) {
    // Label = the last path segment (repo name).
    const label = normalized.split('/').pop() || normalized;
    return { projectKey: normalized, projectLabel: label };
  }

  // Fallback: path:<sha256(realpath(repo-root))>.
  let real = repoRoot;
  try {
    real = _execSeam.realpath(repoRoot);
  } catch {
    /* realpath failed (path gone) — hash the resolved path we have */
  }
  const hash = crypto.createHash('sha256').update(real).digest('hex');
  return { projectKey: `path:${hash}`, projectLabel: path.basename(real) || 'project' };
}
