import * as vscode from 'vscode';

/**
 * Read & write helpers for the mobile / landing mini-IDE modal.
 *
 * Resolves paths inside the open VS Code workspace folders. Tries the
 * direct workspace-relative path first, then falls back to a recursive
 * suffix-match search bounded to noise-free dirs and a max depth, so an
 * agent that emits a path relative to a *deeper* dir (e.g.
 * `services/foo.ts` when the file actually lives at
 * `apps/cli/src/services/foo.ts`) still resolves cleanly.
 *
 * Goes through `vscode.workspace.fs` so the implementation is uniform
 * across local, remote, and SSH workspaces.
 */

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_WALK_DEPTH = 6;
const MAX_VISITED_DIRS = 5000;

const SUBDIR_IGNORE = new Set<string>([
  'node_modules', '.git', '.next', '.expo', 'dist', 'build', 'out', '.cache',
  'coverage', '.turbo', '.parcel-cache', '.idea', '.vscode', '.vscode-test',
  'ios', 'android',
  '.gradle', '.cxx', '.intellijPlatform', '.kotlin',
  'tmp', 'target', 'venv', '.venv', '.mypy_cache', '.pytest_cache',
  '__pycache__',
]);

interface WalkContext {
  visited: number;
  matches: vscode.Uri[];
  cap: number;
}

export class FileOpsService {
  static async readFile(rawPath: string): Promise<{ content?: string; error?: string }> {
    try {
      const uri = await this.resolve(rawPath);
      if (!uri) return { error: `File not found in the workspace: ${rawPath}` };
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type !== vscode.FileType.File) {
        return { error: 'Not a regular file.' };
      }
      if (stat.size > MAX_BYTES) {
        return { error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB).` };
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (this.looksBinary(bytes)) {
        return { error: 'Binary file — refusing to open in a code editor.' };
      }
      return { content: new TextDecoder('utf-8').decode(bytes) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Read failed';
      return { error: msg };
    }
  }

  static async writeFile(rawPath: string, content: string): Promise<{ ok?: boolean; error?: string }> {
    try {
      const uri = (await this.resolve(rawPath)) ?? this.directWriteTarget(rawPath);
      if (!uri) return { error: 'Path escapes the open workspace.' };
      const bytes = new TextEncoder().encode(content);
      if (bytes.byteLength > MAX_BYTES) {
        return { error: 'Content too large.' };
      }
      const parent = vscode.Uri.joinPath(uri, '..');
      try {
        await vscode.workspace.fs.createDirectory(parent);
      } catch {
        /* already exists */
      }
      await vscode.workspace.fs.writeFile(uri, bytes);
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Write failed';
      return { error: msg };
    }
  }

  /**
   * Direct (cwd-relative) write target — used when `resolve()` couldn't
   * find an existing file but the caller wants to create a new one.
   * Always sandboxed under a workspace folder.
   */
  private static directWriteTarget(rawPath: string): vscode.Uri | null {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) return null;
    for (const folder of folders) {
      const root = folder.uri;
      const candidate = rawPath.startsWith('/')
        ? vscode.Uri.file(rawPath)
        : vscode.Uri.joinPath(root, rawPath);
      const candidatePath = candidate.fsPath;
      const rootPath = root.fsPath.endsWith('/') ? root.fsPath : root.fsPath + '/';
      if (candidatePath === root.fsPath || candidatePath.startsWith(rootPath)) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * Pass 1: try every workspace folder + the direct relative path.
   * Pass 2: recursive suffix-match walk inside each folder. Returns the
   * shortest matching path so the file closest to the project root wins.
   */
  private static async resolve(rawPath: string): Promise<vscode.Uri | null> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) return null;

    // Pass 1
    for (const folder of folders) {
      const direct = this.directIn(folder.uri, rawPath);
      if (!direct) continue;
      try {
        const stat = await vscode.workspace.fs.stat(direct);
        if (stat.type === vscode.FileType.File) return direct;
      } catch {
        /* not at direct path */
      }
    }

    // Pass 2
    const normalized = rawPath.replace(/^[./\\]+/, '').replace(/\\/g, '/');
    const needles = [`/${normalized}`];

    const ctx: WalkContext = { visited: 0, matches: [], cap: 16 };
    for (const folder of folders) {
      await this.walk(folder.uri, needles, 0, ctx);
      if (ctx.matches.length >= ctx.cap) break;
    }
    if (ctx.matches.length === 0) return null;

    ctx.matches.sort((a, b) => a.fsPath.length - b.fsPath.length);
    return ctx.matches[0];
  }

  private static directIn(root: vscode.Uri, rawPath: string): vscode.Uri | null {
    if (rawPath.startsWith('/')) {
      const abs = vscode.Uri.file(rawPath);
      const rootPath = root.fsPath.endsWith('/') ? root.fsPath : root.fsPath + '/';
      if (abs.fsPath === root.fsPath || abs.fsPath.startsWith(rootPath)) return abs;
      return null;
    }
    return vscode.Uri.joinPath(root, rawPath);
  }

  private static async walk(
    dir: vscode.Uri,
    needles: string[],
    depth: number,
    ctx: WalkContext,
  ): Promise<void> {
    if (depth > MAX_WALK_DEPTH) return;
    if (ctx.visited > MAX_VISITED_DIRS) return;
    if (ctx.matches.length >= ctx.cap) return;
    ctx.visited++;

    let entries: [string, vscode.FileType][] = [];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return;
    }

    for (const [name, type] of entries) {
      if (type === vscode.FileType.File) {
        const full = vscode.Uri.joinPath(dir, name);
        const fp = full.fsPath.replace(/\\/g, '/');
        if (needles.some((n) => fp.endsWith(n))) {
          ctx.matches.push(full);
          if (ctx.matches.length >= ctx.cap) return;
        }
      }
    }
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.Directory) continue;
      if (SUBDIR_IGNORE.has(name)) continue;
      await this.walk(vscode.Uri.joinPath(dir, name), needles, depth + 1, ctx);
      if (ctx.matches.length >= ctx.cap) return;
    }
  }

  private static looksBinary(bytes: Uint8Array): boolean {
    const len = Math.min(8192, bytes.byteLength);
    for (let i = 0; i < len; i++) {
      if (bytes[i] === 0) return true;
    }
    return false;
  }
}
