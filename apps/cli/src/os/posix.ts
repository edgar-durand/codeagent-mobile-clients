import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { findInPathFor, type OsStrategy, type KeepAwakeCommand } from './strategy';
import { UnixPtyStrategy } from '../services/pty/unix.strategy';
import type { IPtyStrategy, PtyStrategyOptions } from '../services/pty/types';

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

  buildLaunch(binaryPath: string, extraArgs: string[] = []): { cmd: string; args: string[] } {
    // POSIX: no script-wrapping needed. The binary's shebang
    // (#!/usr/bin/env node, #!/bin/sh, …) is honored by execve(2)
    // directly, so spawning the absolute path is correct for
    // every interpreted + compiled language.
    return { cmd: binaryPath, args: [...extraArgs] };
  }

  createPtyStrategies(opts: PtyStrategyOptions): IPtyStrategy[] {
    // POSIX has one PTY backend: the Python `pty.openpty()` helper
    // wrapped in `UnixPtyStrategy`. We don't try `spawnDirect` as a
    // fallback because without a real PTY, Claude / Codex fall into
    // their `--print` non-interactive paths, which produces a worse
    // UX than a clean failure that tells the user "install Python 3".
    return [new UnixPtyStrategy(opts)];
  }

  // darwin + linux diverge here (caffeinate vs systemd-inhibit), so the base
  // leaves it abstract and each subclass supplies its own.
  abstract keepAwakeCommand(pid: number): KeepAwakeCommand | null;
}

export class DarwinOsStrategy extends PosixOsStrategy {
  readonly id = 'darwin' as const;

  keepAwakeCommand(pid: number): KeepAwakeCommand {
    // -i prevent idle sleep, -s prevent system sleep (on AC), -w exit when the
    // CLI pid exits (auto-release). caffeinate ships with macOS (/usr/bin).
    return { cmd: 'caffeinate', args: ['-i', '-s', '-w', String(pid)] };
  }
}

export class LinuxOsStrategy extends PosixOsStrategy {
  readonly id = 'linux' as const;

  keepAwakeCommand(pid: number): KeepAwakeCommand {
    // Hold a logind sleep+idle inhibitor for as long as the CLI pid lives:
    // `tail --pid=<pid> -f /dev/null` blocks until that pid exits, then
    // systemd-inhibit releases the lock. --mode=block = a hard inhibitor.
    // Absent on a non-systemd box → the spawn just errors and no-ops (the
    // service swallows it).
    return {
      cmd: 'systemd-inhibit',
      args: [
        '--what=sleep:idle',
        '--why=CodeAgent local session active',
        '--mode=block',
        'tail',
        `--pid=${pid}`,
        '-f',
        '/dev/null',
      ],
    };
  }
}
