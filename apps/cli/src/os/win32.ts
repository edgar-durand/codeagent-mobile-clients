import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { findInPathFor, type OsStrategy } from './strategy';

const WINDOWS_EXEC_EXTS = ['.exe', '.cmd', '.bat', '.ps1'] as const;

export class Win32OsStrategy implements OsStrategy {
  readonly id = 'win32' as const;

  homeDir(): string {
    return os.homedir();
  }

  scratchPath(prefix: string): string {
    const tag = `${process.pid}-${randomBytes(4).toString('hex')}`;
    return path.join(os.tmpdir(), `${prefix}-${tag}`);
  }

  devNull(): string {
    return 'NUL';
  }

  findInPath(name: string): string | null {
    // If the caller already passed `claude.cmd`, don't re-probe
    // alternative extensions — they explicitly want that shim.
    // Otherwise mirror cmd.exe's PATHEXT resolution: try the bare
    // name LAST so a `.exe` shim wins over a same-named directory
    // entry without extension.
    const hasExt = path.extname(name).length > 0;
    return findInPathFor(name, {
      candidates: (n) =>
        hasExt ? [n] : [...WINDOWS_EXEC_EXTS.map((ext) => `${n}${ext}`), n],
      // Windows has no Unix execute bit; presence + matching extension
      // IS the executability check. X_OK on Windows is a no-op alias
      // for F_OK at the libuv layer anyway, but F_OK makes intent
      // explicit.
      accessFlag: fs.constants.F_OK,
      accessSync: fs.accessSync,
    });
  }

  augmentPath(dirs: string[]): void {
    if (dirs.length === 0) return;
    const cur = process.env.PATH ?? '';
    // Case-insensitive de-duplication: Windows treats `C:\\bin` and
    // `c:\\bin` as the same dir, so don't add a duplicate if a
    // case-different version is already present.
    const existing = new Set(cur.split(';').map((d) => d.toLowerCase()));
    const additions = dirs.filter((d) => !existing.has(d.toLowerCase()));
    if (additions.length === 0) return;
    process.env.PATH = [...additions, cur].filter(Boolean).join(';');
  }

  escapeShellArg(s: string): string {
    // cmd.exe quoting is famously broken. Strategy borrowed from
    // libuv / Microsoft's official guidance:
    //   1. If arg has no whitespace / quotes / metachars, return as-is.
    //   2. Otherwise wrap in double-quotes and escape per the
    //      "Parsing C++ Command-Line Arguments" rules:
    //      - Every backslash run that PRECEDES a `"` must be doubled.
    //      - Each literal `"` becomes `\"`.
    //   3. Additionally escape cmd.exe metachars (& | ^ < > ( ) %)
    //      with `^` so cmd.exe doesn't expand them BEFORE the
    //      child process sees the args.
    if (s.length > 0 && !/[\s"^&|<>()%!]/.test(s)) {
      return s;
    }
    // Step 2: backslash + quote handling.
    let escaped = '';
    let backslashRun = 0;
    for (const ch of s) {
      if (ch === '\\') {
        backslashRun++;
        continue;
      }
      if (ch === '"') {
        escaped += '\\'.repeat(backslashRun * 2) + '\\"';
        backslashRun = 0;
        continue;
      }
      if (backslashRun > 0) {
        escaped += '\\'.repeat(backslashRun);
        backslashRun = 0;
      }
      escaped += ch;
    }
    // Trailing backslashes before the closing quote double up so
    // the parser doesn't read the `\"` as an embedded quote.
    escaped += '\\'.repeat(backslashRun * 2);
    // Step 3: caret-escape cmd.exe metachars. We do this AFTER the
    // surrounding quote because cmd.exe's quote-scanning is its
    // first pass; escaping inside quotes is still necessary for
    // `%VAR%` expansion and `!delayed!` (when delayed expansion is
    // on) — `^` neutralises both.
    return `"${escaped.replace(/[&|^<>()%!]/g, '^$&')}"`;
  }

  buildLaunch(binaryPath: string, extraArgs: string[] = []): { cmd: string; args: string[] } {
    // ConPTY + raw spawn need the WIN32_FIND_DATA executable image —
    // they don't run .cmd/.bat (those are cmd.exe scripts) or .ps1
    // (PowerShell scripts). Wrap by hand to bypass `shell: true`,
    // which would re-tokenise the args via cmd.exe's parser.
    const ext = path.extname(binaryPath).toLowerCase();
    if (ext === '.cmd' || ext === '.bat') {
      return { cmd: 'cmd.exe', args: ['/c', binaryPath, ...extraArgs] };
    }
    if (ext === '.ps1') {
      return {
        cmd: 'powershell.exe',
        args: [
          '-NoProfile',
          // -NonInteractive ensures the script can't prompt for
          // input that would stall the spawn — the user's PowerShell
          // profile (Set-ExecutionPolicy popup, OneDrive auth)
          // otherwise hangs the agent's first boot.
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          binaryPath,
          ...extraArgs,
        ],
      };
    }
    // .exe or extension-less binary → direct spawn.
    return { cmd: binaryPath, args: [...extraArgs] };
  }
}
