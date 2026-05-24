import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { findInPathFor, type OsStrategy } from './strategy';

/**
 * Shared base for darwin + linux. The two platforms differ in tiny,
 * agent-specific ways (Keychain access on macOS, XDG layout on
 * Linux) that will live on the per-platform subclasses or on
 * future agent-strategy methods. For PATH probing, shell escaping,
 * and devNull they're identical, so we don't pretend otherwise.
 */
export abstract class PosixOsStrategy implements OsStrategy {
  abstract readonly id: 'darwin' | 'linux';

  homeDir(): string {
    return os.homedir();
  }

  scratchPath(prefix: string): string {
    // pid + 8 random hex chars: collision-free across concurrent
    // CLI instances; ASCII-safe for paths Python/agent helpers
    // ingest as argv.
    const tag = `${process.pid}-${randomBytes(4).toString('hex')}`;
    return path.join(os.tmpdir(), `${prefix}-${tag}`);
  }

  devNull(): string {
    return '/dev/null';
  }

  findInPath(name: string): string | null {
    // POSIX has no PATHEXT — the binary name is the binary name.
    // Tools that need to probe `python` vs `python3` do it explicitly
    // at the call site. We respect that and don't fan out candidates.
    return findInPathFor(name, {
      candidates: () => [name],
      accessFlag: fs.constants.X_OK,
      accessSync: fs.accessSync,
    });
  }

  augmentPath(dirs: string[]): void {
    if (dirs.length === 0) return;
    const cur = process.env.PATH ?? '';
    const additions = dirs.filter((d) => !cur.split(':').includes(d));
    if (additions.length === 0) return;
    process.env.PATH = [...additions, cur].filter(Boolean).join(':');
  }

  escapeShellArg(s: string): string {
    // POSIX single-quote: every char is literal except `'`. The
    // standard idiom is to break out, escape the `'`, and re-enter.
    // Empty string still needs quoting so `bash -c "$(...)"` sees
    // an arg.
    return `'${s.replace(/'/g, `'\\''`)}'`;
  }
}

export class DarwinOsStrategy extends PosixOsStrategy {
  readonly id = 'darwin' as const;
}

export class LinuxOsStrategy extends PosixOsStrategy {
  readonly id = 'linux' as const;
}
