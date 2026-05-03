import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execFileP = promisify(execFile);

const PROJECT_IGNORE = new Set<string>([
  'node_modules', '.git', '.next', '.expo', 'dist', 'build', 'out', '.cache',
  'coverage', '.turbo', '.parcel-cache', '.idea', '.vscode', '.vscode-test',
  'ios', 'android', '.gradle', '.cxx', '.intellijPlatform', '.kotlin',
  'tmp', 'target', 'venv', '.venv', '.mypy_cache', '.pytest_cache',
  '__pycache__',
]);

const MAX_TREE_FILES = 5000;
const MAX_DIFF_BYTES = 512 * 1024;
const MAX_GIT_OUTPUT = 256 * 1024;

export interface FileTreeEntry {
  path: string;
  name: string;
  size: number;
}

export class ProjectOpsService {
  private static workspaceRoot(): string | null {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) return null;
    return folders[0].uri.fsPath;
  }

  static async listFiles(query?: string): Promise<{
    files: FileTreeEntry[];
    truncated: boolean;
    root: string;
  }> {
    const root = this.workspaceRoot();
    if (!root) return { files: [], truncated: false, root: '' };
    const q = (query ?? '').trim().toLowerCase();
    const out: FileTreeEntry[] = [];
    let truncated = false;

    const walk = async (dirAbs: string, depth: number): Promise<void> => {
      if (out.length >= MAX_TREE_FILES) { truncated = true; return; }
      let entries: [string, vscode.FileType][] = [];
      try {
        entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dirAbs));
      } catch { return; }
      for (const [name, type] of entries) {
        if (out.length >= MAX_TREE_FILES) { truncated = true; return; }
        if (PROJECT_IGNORE.has(name)) continue;
        const full = path.join(dirAbs, name);
        if (type === vscode.FileType.Directory) {
          if (depth >= 12) continue;
          await walk(full, depth + 1);
        } else if (type === vscode.FileType.File) {
          const rel = path.relative(root, full);
          if (q && !rel.toLowerCase().includes(q) && !name.toLowerCase().includes(q)) continue;
          let size = 0;
          try {
            const stat = await vscode.workspace.fs.stat(vscode.Uri.file(full));
            size = stat.size;
          } catch { /* ignore */ }
          out.push({ path: rel, name, size });
        }
      }
    };

    await walk(root, 0);
    out.sort((a, b) => a.path.localeCompare(b.path));
    return { files: out, truncated, root };
  }

  private static async git(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    const root = this.workspaceRoot();
    if (!root) return { stdout: '', stderr: 'No workspace open', code: 1 };
    try {
      const { stdout, stderr } = await execFileP('git', args, {
        cwd: root,
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

  static async gitStatus(): Promise<Record<string, unknown>> {
    const r = await this.git(['status', '--porcelain=v2', '--branch']);
    if (r.code !== 0) {
      return { branch: null, upstream: null, ahead: 0, behind: 0, entries: [], hasMergeInProgress: false, error: r.stderr.trim() };
    }
    const lines = r.stdout.split('\n').filter(Boolean);
    let branch: string | null = null;
    let upstream: string | null = null;
    let ahead = 0;
    let behind = 0;
    const entries: Array<{ code: string; path: string; oldPath?: string; staged: boolean; conflict: boolean }> = [];
    for (const line of lines) {
      if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length).trim();
      else if (line.startsWith('# branch.upstream ')) upstream = line.slice('# branch.upstream '.length).trim();
      else if (line.startsWith('# branch.ab ')) {
        const m = line.match(/\+(\d+)\s+-(\d+)/);
        if (m) { ahead = parseInt(m[1], 10); behind = parseInt(m[2], 10); }
      } else if (line.startsWith('1 ')) {
        const parts = line.split(' ');
        const xy = parts[1];
        const p = parts.slice(8).join(' ');
        entries.push({ code: xy, path: p, staged: xy[0] !== '.', conflict: false });
      } else if (line.startsWith('2 ')) {
        const parts = line.split(' ');
        const xy = parts[1];
        const tail = parts.slice(9).join(' ');
        const [newPath, oldPath] = tail.split('\t');
        entries.push({ code: xy, path: newPath ?? '', oldPath: oldPath ?? undefined, staged: xy[0] !== '.', conflict: false });
      } else if (line.startsWith('? ')) {
        entries.push({ code: '??', path: line.slice(2), staged: false, conflict: false });
      } else if (line.startsWith('u ')) {
        const parts = line.split(' ');
        const xy = parts[1];
        const p = parts.slice(10).join(' ');
        entries.push({ code: xy, path: p, staged: false, conflict: true });
      }
    }

    let hasMergeInProgress = false;
    try {
      const root = this.workspaceRoot();
      if (root) {
        const head = await vscode.workspace.fs.stat(vscode.Uri.file(path.join(root, '.git', 'MERGE_HEAD')));
        if (head) hasMergeInProgress = true;
      }
    } catch { /* no merge */ }

    return { branch, upstream, ahead, behind, entries, hasMergeInProgress };
  }

  static async gitDiff(file: string | null): Promise<{ diff: string; truncated: boolean; error?: string }> {
    const args = ['diff', '--no-color', '--patch'];
    if (file) args.push('--', file);
    const r = await this.git(args);
    if (r.code !== 0 && !r.stdout) return { diff: '', truncated: false, error: r.stderr.trim() };
    const truncated = r.stdout.length >= MAX_DIFF_BYTES;
    return { diff: r.stdout.slice(0, MAX_DIFF_BYTES), truncated };
  }

  static async gitDiffStaged(file: string | null): Promise<{ diff: string; truncated: boolean; error?: string }> {
    const args = ['diff', '--cached', '--no-color', '--patch'];
    if (file) args.push('--', file);
    const r = await this.git(args);
    if (r.code !== 0 && !r.stdout) return { diff: '', truncated: false, error: r.stderr.trim() };
    const truncated = r.stdout.length >= MAX_DIFF_BYTES;
    return { diff: r.stdout.slice(0, MAX_DIFF_BYTES), truncated };
  }

  static async gitLog(limit = 30): Promise<{ commits: Array<Record<string, string>>; error?: string }> {
    const sep = '';
    const fmt = ['%H', '%h', '%an', '%aI', '%s'].join(sep);
    const r = await this.git(['log', `-n${Math.min(limit, 200)}`, `--pretty=format:${fmt}`]);
    if (r.code !== 0) return { commits: [], error: r.stderr.trim() };
    const commits = r.stdout.split('\n').filter(Boolean).map((line) => {
      const [hash, shortHash, author, date, subject] = line.split(sep);
      return { hash, shortHash, author, date, subject };
    });
    return { commits };
  }

  static async gitCommit(message: string, paths?: string[]): Promise<{ ok?: boolean; commit?: string; error?: string }> {
    if (!message || message.trim().length === 0) return { error: 'Commit message is required.' };
    const add = paths && paths.length > 0
      ? await this.git(['add', '--', ...paths])
      : await this.git(['add', '-A']);
    if (add.code !== 0) return { error: `git add failed: ${add.stderr.trim()}` };
    const r = await this.git(['commit', '-m', message]);
    if (r.code !== 0) return { error: r.stderr.trim() || 'git commit failed' };
    const head = await this.git(['rev-parse', 'HEAD']);
    return { ok: true, commit: head.stdout.trim() };
  }

  static async gitPush(): Promise<{ ok?: boolean; output?: string; error?: string }> {
    const r = await this.git(['push']);
    if (r.code !== 0) return { error: r.stderr.trim() || 'git push failed' };
    return { ok: true, output: (r.stdout + r.stderr).trim() };
  }

  static async gitPull(): Promise<{ ok?: boolean; output?: string; error?: string }> {
    const r = await this.git(['pull', '--ff-only']);
    if (r.code !== 0) return { error: r.stderr.trim() || 'git pull failed' };
    return { ok: true, output: (r.stdout + r.stderr).trim() };
  }

  static async gitResolve(file: string, side: 'ours' | 'theirs'): Promise<{ ok?: boolean; error?: string }> {
    const r = await this.git(['checkout', `--${side}`, '--', file]);
    if (r.code !== 0) return { error: r.stderr.trim() || `git checkout --${side} failed` };
    const add = await this.git(['add', '--', file]);
    if (add.code !== 0) return { error: add.stderr.trim() || 'git add (resolve) failed' };
    return { ok: true };
  }
}
