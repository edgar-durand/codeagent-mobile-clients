import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';

const execFileP = promisify(execFile);

/**
 * Project-level operations for the mini-IDE feature: tree listing, git
 * status / diff / log / branch / commit / push / pull, plus the
 * conflict-resolution helpers. All git ops execute via `execFile`
 * (never `exec`) so payloads can't be shell-injected. Output is
 * size-capped to keep the wire small and the client modal snappy.
 */

const PROJECT_IGNORE = new Set([
  'node_modules', '.git', '.next', '.expo', 'dist', 'build', 'out', '.cache',
  'coverage', '.turbo', '.parcel-cache', '.idea', '.vscode', '.vscode-test',
  'ios', 'android', '.gradle', '.cxx', '.intellijPlatform', '.kotlin',
  'tmp', 'target', 'venv', '.venv', '.mypy_cache', '.pytest_cache',
  '__pycache__', '.DS_Store',
]);

// Upper bound on entries returned from `listProjectFiles`. Sized
// against the api-v2 body-parser limit (10 MB) and the average
// entry payload (~150 bytes serialised) — 50 000 gives ~7.5 MB
// worst case, comfortably under the wire cap. Monorepos with 3-4
// sibling repos under one parent dir routinely exceed 5 000.
const MAX_TREE_FILES = 50_000;
const MAX_DIFF_BYTES = 512 * 1024;
const MAX_GIT_OUTPUT = 256 * 1024;

export interface FileTreeEntry {
  /** Path relative to the project root. */
  path: string;
  /** Filename (basename) for fast display. */
  name: string;
  size: number;
}

interface ListFilesOpts {
  cwd?: string;
  query?: string;
  /** Cap on returned entries so a huge monorepo doesn't blow the wire. */
  cap?: number;
}

export async function listProjectFiles(opts: ListFilesOpts = {}): Promise<{
  files: FileTreeEntry[];
  truncated: boolean;
  root: string;
}> {
  const root = opts.cwd ?? process.cwd();
  const cap = opts.cap ?? MAX_TREE_FILES;
  const q = (opts.query ?? '').trim().toLowerCase();
  const out: FileTreeEntry[] = [];
  let truncated = false;

  async function walk(dir: string, depth: number): Promise<void> {
    if (out.length >= cap) {
      truncated = true;
      return;
    }
    let entries: import('fs').Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= cap) {
        truncated = true;
        return;
      }
      if (PROJECT_IGNORE.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth >= 12) continue;
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        const rel = path.relative(root, full);
        if (q && !rel.toLowerCase().includes(q) && !e.name.toLowerCase().includes(q)) {
          continue;
        }
        let size = 0;
        try {
          const st = await fs.stat(full);
          size = st.size;
        } catch {
          /* ignore */
        }
        out.push({ path: rel, name: e.name, size });
      }
    }
  }

  await walk(root, 0);
  // Sort: by path so the tree is deterministic.
  out.sort((a, b) => a.path.localeCompare(b.path));
  return { files: out, truncated, root };
}

async function git(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileP('git', args, {
      cwd: cwd ?? process.cwd(),
      maxBuffer: MAX_GIT_OUTPUT,
      timeout: 30_000,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? 'git failed',
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

export interface GitStatusEntry {
  /** Two-letter porcelain code: `M`, `??`, `A`, `D`, `R`, `UU`, etc. */
  code: string;
  /** Path the user sees. For renames, this is the new path. */
  path: string;
  /** Old path on rename, otherwise undefined. */
  oldPath?: string;
  /** Convenience: 'staged' if first column is non-space, else 'unstaged'. */
  staged: boolean;
  /** Convenience: 'conflict' when both columns are conflict markers. */
  conflict: boolean;
}

export async function gitStatus(cwd?: string): Promise<{
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
  hasMergeInProgress: boolean;
  error?: string;
}> {
  const root = cwd ?? process.cwd();
  const r = await git(['status', '--porcelain=v2', '--branch'], root);
  if (r.code !== 0) {
    return {
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      entries: [],
      hasMergeInProgress: false,
      error: r.stderr.trim(),
    };
  }
  const lines = r.stdout.split('\n').filter(Boolean);
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const entries: GitStatusEntry[] = [];
  for (const line of lines) {
    if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length).trim();
    else if (line.startsWith('# branch.upstream ')) upstream = line.slice('# branch.upstream '.length).trim();
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) { ahead = parseInt(m[1], 10); behind = parseInt(m[2], 10); }
    } else if (line.startsWith('1 ')) {
      // 1 XY sub <mH> <mI> <mW> <hH> <hI> path
      const parts = line.split(' ');
      const xy = parts[1];
      const p = parts.slice(8).join(' ');
      entries.push({
        code: xy,
        path: p,
        staged: xy[0] !== '.',
        conflict: false,
      });
    } else if (line.startsWith('2 ')) {
      // Renamed: 2 XY sub <mH> <mI> <mW> <hH> <hI> <X><score> <path><tab><orig-path>
      const parts = line.split(' ');
      const xy = parts[1];
      const tail = parts.slice(9).join(' ');
      const [newPath, oldPath] = tail.split('\t');
      entries.push({
        code: xy,
        path: newPath ?? '',
        oldPath: oldPath ?? undefined,
        staged: xy[0] !== '.',
        conflict: false,
      });
    } else if (line.startsWith('? ')) {
      entries.push({
        code: '??',
        path: line.slice(2),
        staged: false,
        conflict: false,
      });
    } else if (line.startsWith('u ')) {
      // Unmerged: u XY sub <m1> <m2> <m3> <mW> <h1> <h2> <h3> path
      const parts = line.split(' ');
      const xy = parts[1];
      const p = parts.slice(10).join(' ');
      entries.push({
        code: xy,
        path: p,
        staged: false,
        conflict: true,
      });
    }
  }

  // Detect merge in progress (.git/MERGE_HEAD).
  let hasMergeInProgress = false;
  try {
    const gitDir = (await git(['rev-parse', '--git-dir'], root)).stdout.trim();
    const mergeHead = path.isAbsolute(gitDir)
      ? path.join(gitDir, 'MERGE_HEAD')
      : path.join(root, gitDir, 'MERGE_HEAD');
    await fs.access(mergeHead);
    hasMergeInProgress = true;
  } catch {
    /* no merge */
  }

  return { branch, upstream, ahead, behind, entries, hasMergeInProgress };
}

export async function gitDiff(file: string | null, cwd?: string): Promise<{ diff: string; truncated: boolean; error?: string }> {
  const args = ['diff', '--no-color', '--patch'];
  if (file) args.push('--', file);
  const r = await git(args, cwd);
  if (r.code !== 0 && !r.stdout) {
    return { diff: '', truncated: false, error: r.stderr.trim() };
  }
  const truncated = r.stdout.length >= MAX_DIFF_BYTES;
  return { diff: r.stdout.slice(0, MAX_DIFF_BYTES), truncated };
}

export async function gitDiffStaged(file: string | null, cwd?: string): Promise<{ diff: string; truncated: boolean; error?: string }> {
  const args = ['diff', '--cached', '--no-color', '--patch'];
  if (file) args.push('--', file);
  const r = await git(args, cwd);
  if (r.code !== 0 && !r.stdout) {
    return { diff: '', truncated: false, error: r.stderr.trim() };
  }
  const truncated = r.stdout.length >= MAX_DIFF_BYTES;
  return { diff: r.stdout.slice(0, MAX_DIFF_BYTES), truncated };
}

export interface GitLogEntry {
  /** Full commit SHA. Matches @codeam/ide-core's GitLogEntry. */
  sha: string;
  /** First line of the commit message. */
  subject: string;
  /** Author display name. */
  author: string;
  /** Commit timestamp (epoch ms). */
  timestamp: number;
  /** Branch / tag refs pointing at this commit, e.g. ["main",
   * "origin/main"]. Empty when none. */
  refs?: string[];
}

export async function gitLog(limit = 30, cwd?: string): Promise<{ commits: GitLogEntry[]; error?: string }> {
  const SEP = '\x1f';
  const fmt = `%H${SEP}%s${SEP}%an${SEP}%ct${SEP}%D`;
  const r = await git(['log', `-n${Math.min(limit, 200)}`, `--pretty=format:${fmt}`], cwd);
  if (r.code !== 0) return { commits: [], error: r.stderr.trim() };
  const commits: GitLogEntry[] = r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, subject, author, ts, refs] = line.split(SEP);
      return {
        sha: sha ?? '',
        subject: subject ?? '',
        author: author ?? '',
        timestamp: parseInt(ts ?? '0', 10) * 1000,
        refs: (refs ?? '')
          .split(',')
          .map((s) => s.trim().replace(/^HEAD -> /, ''))
          .filter((s) => s.length > 0),
      };
    });
  return { commits };
}

export async function gitCommit(message: string, files?: string[], cwd?: string): Promise<{ ok?: boolean; commit?: string; error?: string }> {
  if (!message || message.trim().length === 0) {
    return { error: 'Commit message is required.' };
  }
  // Stage either the requested files or everything tracked.
  if (files && files.length > 0) {
    const r = await git(['add', '--', ...files], cwd);
    if (r.code !== 0) return { error: `git add failed: ${r.stderr.trim()}` };
  } else {
    const r = await git(['add', '-A'], cwd);
    if (r.code !== 0) return { error: `git add failed: ${r.stderr.trim()}` };
  }
  const r = await git(['commit', '-m', message], cwd);
  if (r.code !== 0) {
    return { error: r.stderr.trim() || 'git commit failed' };
  }
  // Read back the new HEAD hash for the UI.
  const head = await git(['rev-parse', 'HEAD'], cwd);
  return { ok: true, commit: head.stdout.trim() };
}

export async function gitPush(cwd?: string): Promise<{ ok?: boolean; output?: string; error?: string }> {
  const r = await git(['push'], cwd);
  if (r.code !== 0) return { error: r.stderr.trim() || 'git push failed' };
  return { ok: true, output: (r.stdout + r.stderr).trim() };
}

export async function gitPull(cwd?: string): Promise<{ ok?: boolean; output?: string; error?: string }> {
  const r = await git(['pull', '--ff-only'], cwd);
  if (r.code !== 0) return { error: r.stderr.trim() || 'git pull failed' };
  return { ok: true, output: (r.stdout + r.stderr).trim() };
}

export async function gitResolve(file: string, side: 'ours' | 'theirs', cwd?: string): Promise<{ ok?: boolean; error?: string }> {
  const r = await git(['checkout', `--${side}`, '--', file], cwd);
  if (r.code !== 0) return { error: r.stderr.trim() || `git checkout --${side} failed` };
  const add = await git(['add', '--', file], cwd);
  if (add.code !== 0) return { error: add.stderr.trim() || 'git add (resolve) failed' };
  return { ok: true };
}

// ── Content search ─────────────────────────────────────────────

const MAX_SEARCH_HITS = 500;
const MAX_SEARCH_BYTES = 256 * 1024;

export interface SearchHit {
  path: string;
  line: number;
  column: number;
  text: string;
  matchLength: number;
}

interface SearchFilesOpts {
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  include?: string[];
  exclude?: string[];
  maxResults?: number;
  cwd?: string;
}

/**
 * Multi-file content search powered by `git grep` (falls back to
 * a JS regex scan when the cwd isn't a git repo). Respects
 * .gitignore by default, scales to large monorepos, and capped at
 * MAX_SEARCH_HITS to keep the wire small.
 */
export async function searchFiles(opts: SearchFilesOpts): Promise<{
  hits: SearchHit[];
  total: number;
  truncated: boolean;
}> {
  const cwd = opts.cwd ?? process.cwd();
  const cap = Math.min(opts.maxResults ?? MAX_SEARCH_HITS, MAX_SEARCH_HITS);
  if (!opts.query.trim()) return { hits: [], total: 0, truncated: false };

  // `git grep -n --column` prints `path:line:column:text`. We
  // shell-quote nothing because execFile takes args directly.
  const args = ['grep', '-n', '--column', '-I'];
  if (!opts.caseSensitive) args.push('-i');
  if (opts.wholeWord) args.push('-w');
  if (opts.regex) args.push('-E');
  else args.push('-F');
  args.push(opts.query);
  // Path filters: `:!exclude` syntax tells git grep to exclude.
  // Includes are appended as literal pathspecs.
  if (opts.include && opts.include.length > 0) {
    args.push('--');
    for (const p of opts.include) args.push(p);
  } else if (opts.exclude && opts.exclude.length > 0) {
    args.push('--');
    args.push('.');
  }
  for (const p of opts.exclude ?? []) args.push(`:!${p}`);

  const r = await git(args, cwd);
  // Exit code 1 means "no matches" — not an error.
  if (r.code !== 0 && r.code !== 1) {
    // Fall back to a JS scan when git isn't available.
    return jsSearchFiles(opts, cwd, cap);
  }
  const hits: SearchHit[] = [];
  const lines = r.stdout.split('\n');
  let truncated = false;
  let byteBudget = MAX_SEARCH_BYTES;
  for (const line of lines) {
    if (!line) continue;
    if (hits.length >= cap) {
      truncated = true;
      break;
    }
    if (byteBudget <= 0) {
      truncated = true;
      break;
    }
    byteBudget -= line.length;
    // path:line:column:text (path may contain colons, but git's
    // output uses NUL separators only with -z. We split from the
    // right keeping path intact.)
    const m = line.match(/^([^ ]+?):(\d+):(\d+):(.*)$/);
    if (!m) continue;
    const filePath = m[1] ?? '';
    const lineNo = parseInt(m[2] ?? '0', 10);
    const col = parseInt(m[3] ?? '1', 10);
    const text = (m[4] ?? '').slice(0, 400);
    if (!filePath) continue;
    hits.push({
      path: filePath,
      line: lineNo,
      column: col,
      text,
      matchLength: opts.query.length,
    });
  }
  return { hits, total: hits.length, truncated };
}

/**
 * Best-effort JS fallback when `git grep` isn't an option (no git,
 * git binary missing). Walks the project files the same way
 * `listProjectFiles` does and scans them line-by-line. Much
 * slower; deliberately capped to keep latency bounded.
 */
async function jsSearchFiles(
  opts: SearchFilesOpts,
  cwd: string,
  cap: number,
): Promise<{ hits: SearchHit[]; total: number; truncated: boolean }> {
  const files = await listProjectFiles({ cwd, cap: 2000 });
  const hits: SearchHit[] = [];
  const needle = opts.caseSensitive ? opts.query : opts.query.toLowerCase();
  let truncated = files.truncated;
  for (const f of files.files) {
    if (hits.length >= cap) {
      truncated = true;
      break;
    }
    let content = '';
    try {
      content = await fs.readFile(path.join(cwd, f.path), 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length && hits.length < cap; i++) {
      const line = lines[i] ?? '';
      const hay = opts.caseSensitive ? line : line.toLowerCase();
      const idx = hay.indexOf(needle);
      if (idx === -1) continue;
      hits.push({
        path: f.path,
        line: i + 1,
        column: idx + 1,
        text: line.slice(0, 400),
        matchLength: opts.query.length,
      });
    }
  }
  return { hits, total: hits.length, truncated };
}
