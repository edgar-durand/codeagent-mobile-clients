import * as vscode from 'vscode';

/**
 * Read & write helpers for the mobile / landing mini-IDE modal. Resolves
 * paths against the active workspace folders and refuses anything that
 * escapes them, so a malicious or buggy client can't reach outside the
 * project the user has open. Goes through `vscode.workspace.fs` so the
 * implementation is uniform across local, remote, and SSH workspaces.
 */
export class FileOpsService {
  // 5 MB — generous for code, blocks accidental binary blobs
  private static readonly MAX_BYTES = 5 * 1024 * 1024;

  static async readFile(rawPath: string): Promise<{ content?: string; error?: string }> {
    try {
      const uri = this.resolveSafe(rawPath);
      if (!uri) return { error: 'Path escapes the open workspace.' };
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type !== vscode.FileType.File) {
        return { error: 'Not a regular file.' };
      }
      if (stat.size > this.MAX_BYTES) {
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
      const uri = this.resolveSafe(rawPath);
      if (!uri) return { error: 'Path escapes the open workspace.' };
      const bytes = new TextEncoder().encode(content);
      if (bytes.byteLength > this.MAX_BYTES) {
        return { error: 'Content too large.' };
      }
      // Ensure the parent directory exists so the user can create new files.
      const parent = vscode.Uri.joinPath(uri, '..');
      try {
        await vscode.workspace.fs.createDirectory(parent);
      } catch {
        /* already exists or creation isn't needed */
      }
      await vscode.workspace.fs.writeFile(uri, bytes);
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Write failed';
      return { error: msg };
    }
  }

  private static resolveSafe(rawPath: string): vscode.Uri | null {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) return null;
    // Try each workspace folder as the root candidate. Accept either a
    // path relative to the folder or an absolute path that's already inside it.
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

  private static looksBinary(bytes: Uint8Array): boolean {
    const len = Math.min(8192, bytes.byteLength);
    for (let i = 0; i < len; i++) {
      if (bytes[i] === 0) return true;
    }
    return false;
  }
}
