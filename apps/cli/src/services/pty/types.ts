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

/** Scan PATH for an executable; returns the full path or null. */
export function findInPath(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  for (const dir of dirs) {
    const full = `${dir}/${name}`;
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      /* try next */
    }
  }
  return null;
}
