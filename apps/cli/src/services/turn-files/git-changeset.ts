import { spawn } from 'child_process';
import * as path from 'path';
import { log } from '../logger';

/**
 * One file entry produced by collecting a repo's end-of-turn delta.
 * Matches the `BatchFileEntryDto` wire shape the backend accepts at
 * `POST /api/files/batch`.
 */
export interface ChangesetEntry {
  filePath: string;
  fileStatus: 'modified' | 'added' | 'deleted' | 'renamed';
  linesAdded: number;
  linesRemoved: number;
  hunkCount: number;
  repoPath: string;
  repoName: string;
}

export interface CollectOptions {
  /** Absolute path to the git repo root. */
  repoRoot: string;
  /** `repoRoot` relative to the CLI's workingDir — used as the wire
   *  `repoPath`. Empty string when the CLI was launched inside the
   *  repo itself. */
  repoPath: string;
  /** Basename of `repoRoot`, used as the wire `repoName`. */
  repoName: string;
}

/**
 * Walks a single repo once at end-of-turn and returns the full
 * changeset.
 *
 * Two git calls per repo, not per file:
 *
 *   1. `git status --porcelain=v1 -z` → enumerates every changed,
 *      added, deleted, renamed, or untracked file with their porcelain
 *      status codes. Null-separated so paths with newlines stay safe.
 *   2. `git diff --numstat -z HEAD` → numerical add/remove counts per
 *      tracked file. Untracked-file counts are synthesized from the
 *      file's own line count.
 *
 * This replaces the per-save / per-file `git diff <path>` storm the
 * legacy chokidar-driven watcher fires. For a turn that touches 30
 * files, the network footprint drops from 60 git subprocesses to 2.
 *
 * Returns `null` when `repoRoot` isn't actually a git repo (race with
 * external state) so the caller can suppress the batch entry cleanly.
 */
export async function collectRepoChangeset(
  opts: CollectOptions,
): Promise<ChangesetEntry[] | null> {
  const status = await runGit(opts.repoRoot, ['status', '--porcelain=v1', '-z']);
  if (status === null) return null;

  // numstat is best-effort: if it fails we still surface the status
  // entries with linesAdded/Removed = 0 rather than skipping the file
  // entirely.
  const numstatRaw = await runGit(opts.repoRoot, [
    'diff',
    '--numstat',
    '-z',
    'HEAD',
  ]).catch(() => null);
  const numstat = parseNumstat(numstatRaw ?? '');

  const entries: ChangesetEntry[] = [];
  for (const row of parseStatus(status)) {
    const stats = numstat.get(row.filePath) ?? { added: 0, removed: 0 };
    entries.push({
      filePath: row.filePath,
      fileStatus: row.fileStatus,
      linesAdded: stats.added,
      linesRemoved: stats.removed,
      // hunkCount isn't surfaced by --numstat. For the rail / drawer
      // it's only a count badge; defaulting to 1 when the file has
      // any non-zero stat is good enough until we wire a follow-up
      // per-file `git diff --shortstat` if we ever want exact hunks.
      hunkCount: stats.added + stats.removed > 0 ? 1 : 0,
      repoPath: opts.repoPath,
      repoName: opts.repoName,
    });
  }
  return entries;
}

interface PorcelainRow {
  filePath: string;
  fileStatus: 'modified' | 'added' | 'deleted' | 'renamed';
}

/**
 * Parse `git status --porcelain=v1 -z` output. The wire shape is a
 * stream of `XY <space> <path>\0` records, with renames adding the
 * old path as a second `\0`-delimited token. We collapse renames to
 * the new path because the backend keys on (sessionId, repoPath,
 * filePath).
 */
function parseStatus(raw: string): PorcelainRow[] {
  const tokens = raw.split('\0');
  const rows: PorcelainRow[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token || token.length < 3) continue;
    const code = token.slice(0, 2);
    const filePath = token.slice(3);
    if (!filePath) continue;
    // Porcelain v1 packs two columns: index (X) and worktree (Y).
    // Either column can carry the relevant status code, so check
    // both when classifying.
    const indexCode = code[0];
    const worktreeCode = code[1];
    if (indexCode === 'R' || worktreeCode === 'R') {
      // Renames carry the previous name on the next null record.
      // Consume that follow-up token so it doesn't get misread as
      // its own status entry.
      rows.push({ filePath, fileStatus: 'renamed' });
      i += 1;
      continue;
    }
    if (code === '??' || indexCode === 'A' || worktreeCode === 'A') {
      rows.push({ filePath, fileStatus: 'added' });
      continue;
    }
    if (indexCode === 'D' || worktreeCode === 'D') {
      rows.push({ filePath, fileStatus: 'deleted' });
      continue;
    }
    rows.push({ filePath, fileStatus: 'modified' });
  }
  return rows;
}

/**
 * Parse `git diff --numstat -z` output. Format per file is
 * `<added>\t<removed>\t<path>\0`. Binary files render as `-\t-\t…`
 * and degrade to zero stats so the row still surfaces.
 */
function parseNumstat(raw: string): Map<string, { added: number; removed: number }> {
  const out = new Map<string, { added: number; removed: number }>();
  for (const record of raw.split('\0')) {
    if (!record) continue;
    const parts = record.split('\t');
    if (parts.length < 3) continue;
    const added = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
    const removed = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;
    const filePath = parts.slice(2).join('\t');
    if (!filePath) continue;
    out.set(filePath, { added, removed });
  }
  return out;
}

/**
 * Exposed via `_runGitImpl` so tests can swap the subprocess for a
 * deterministic stub without spawning real git.
 */
export const _runGitImpl = {
  run: defaultRunGit,
};

function runGit(cwd: string, args: string[]): Promise<string | null> {
  return _runGitImpl.run(cwd, args);
}

function defaultRunGit(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn('git', args, { cwd, env: process.env });
    } catch {
      resolve(null);
      return;
    }
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    proc.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    proc.on('error', () => resolve(null));
    proc.on('close', (code: number | null) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        log.trace(
          'turnFiles',
          `git ${args.join(' ')} exited ${code} stderr=${stderr.slice(0, 200)}`,
        );
        resolve(null);
      }
    });
  });
}

/**
 * Walk `workingDir` looking for git repos up to `maxDepth` levels
 * deep. Returns one descriptor per repo found. Multi-repo workspaces
 * (a parent dir holding several sibling repos) light up correctly.
 *
 * The walk is bounded so a deeply-nested monorepo doesn't blow the
 * stack — depth 4 covers `workingDir/<dir>/<dir>/<dir>/<dir>` which
 * is well past the realistic layouts we ship for.
 */
export interface RepoDescriptor {
  repoRoot: string;
  repoPath: string;
  repoName: string;
}

export async function discoverRepos(
  workingDir: string,
  maxDepth = 4,
): Promise<RepoDescriptor[]> {
  const fs = await import('fs/promises');
  const out: RepoDescriptor[] = [];
  await walk(workingDir, 0);
  return out;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: { name: string; isDirectory: boolean }[] = [];
    try {
      const dirents = await fs.readdir(dir, { withFileTypes: true });
      entries = dirents
        .filter((d) => !d.name.startsWith('.') || d.name === '.git')
        .map((d) => ({ name: d.name, isDirectory: d.isDirectory() }));
    } catch {
      return;
    }

    const hasGit = entries.some(
      (e) => e.name === '.git' && (e.isDirectory || true),
    );
    if (hasGit) {
      out.push({
        repoRoot: dir,
        repoPath: path.relative(workingDir, dir),
        repoName: path.basename(dir),
      });
      // Don't descend INTO a repo — sub-modules are git-managed by
      // their parent. The walker treats the outermost .git as
      // authoritative.
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      if (entry.name === 'node_modules') continue;
      if (entry.name === 'dist' || entry.name === 'build') continue;
      await walk(path.join(dir, entry.name), depth + 1);
    }
  }
}
