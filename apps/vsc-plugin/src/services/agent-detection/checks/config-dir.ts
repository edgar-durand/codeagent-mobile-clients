import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Expands a leading `~` to the current user's home dir. */
export function expandHome(p: string): string {
  if (!p.startsWith('~')) return p;
  return path.join(os.homedir(), p.slice(1).replace(/^[/\\]/, ''));
}

/**
 * Returns true when `dir` exists AND is a directory (not a file, not a
 * broken symlink). Swallows ENOENT / EACCES — both are treated as "no".
 */
export async function dirExists(dir: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(dir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
