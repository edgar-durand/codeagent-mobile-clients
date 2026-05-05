import * as fs from 'fs';
import * as path from 'path';

export interface PtyStrategyOptions {
  onData: (data: string) => void;
  onExit: (code: number) => void;
}

export interface IPtyStrategy {
  spawn(cmd: string, cwd: string, args?: string[]): void;
  write(data: string | Buffer): void;
  kill(): void;
  dispose(): void;
}

/**
 * Scan PATH for an executable; returns the full path or null.
 *
 * Windows: if `name` has no extension, also probes `.exe`, `.cmd`,
 * `.bat`, `.ps1` (matching cmd.exe / PATHEXT semantics) and uses
 * F_OK rather than X_OK because Windows doesn't have Unix execute
 * bits — every existing file in a PATH dir is "executable" if the
 * extension is right.
 *
 * Returns the full resolved path (with extension on Windows), so
 * callers can hand the result straight to spawn/ConPTY without
 * relying on the spawned process doing its own PATH resolution.
 */
export function findInPath(name: string): string | null {
  const isWin = process.platform === 'win32';
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const hasExt = path.extname(name).length > 0;
  const candidates =
    isWin && !hasExt
      ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, `${name}.ps1`, name]
      : [name];
  const accessFlag = isWin ? fs.constants.F_OK : fs.constants.X_OK;
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      try {
        fs.accessSync(full, accessFlag);
        return full;
      } catch {
        /* try next */
      }
    }
  }
  return null;
}
