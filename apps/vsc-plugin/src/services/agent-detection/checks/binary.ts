import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Returns the absolute path of the first executable in `PATH` whose
 * basename matches `name`, or null when none found.
 *
 * Pure fs traversal — does NOT spawn a subprocess. Cross-OS:
 * iterates `process.env.PATHEXT` extensions on Windows so callers can
 * pass the bare name `codex` and have `codex.exe` / `codex.cmd` etc.
 * resolve transparently.
 */
export async function whichBinary(name: string): Promise<string | null> {
  const isWin = process.platform === 'win32';
  const sep = isWin ? ';' : ':';
  const exts = isWin
    ? (process.env.PATHEXT ?? '.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())
    : [''];
  const pathEntries = (process.env.PATH ?? '').split(sep).filter(Boolean);

  for (const dir of pathEntries) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        await fs.promises.access(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* try next */
      }
    }
  }
  return null;
}
