import * as path from 'path';
import { findInPath } from './pty/types';

export interface ClaudeLaunch {
  /** Executable to spawn — already an absolute path on Windows. */
  cmd: string;
  /** Args including any wrapper-shell prefix (e.g. `/c <real-cmd>`). */
  args: string[];
}

/**
 * Resolve how to launch Claude Code from the current PATH, building
 * a `(cmd, args)` pair that's safe to hand to a raw spawn — including
 * ConPTY, which (unlike `child_process.spawn({ shell: true })`) does
 * NOT do its own PATH lookup or PATHEXT resolution.
 *
 * Cases we handle:
 *   - Unix `claude` binary  → spawn the absolute path directly.
 *   - Windows `claude.exe`  → spawn the absolute path directly.
 *   - Windows `claude.cmd`  → wrap with `cmd.exe /c <abs-path>`
 *   - Windows `claude.bat`  → same as .cmd
 *   - Windows `claude.ps1`  → wrap with `powershell.exe -NoProfile -File <abs-path>`
 *
 * Anthropic's official Windows installer (irm install.ps1 | iex)
 * drops a `claude.cmd` shim into PATH — the wrapping is what was
 * missing in v2.4.31 and caused ConPTY to fail with
 * `File not found:`.
 */
export function buildClaudeLaunch(extraArgs: string[] = []): ClaudeLaunch | null {
  const found = findInPath('claude') ?? findInPath('claude-code');
  if (!found) return null;

  if (process.platform === 'win32') {
    const ext = path.extname(found).toLowerCase();
    if (ext === '.cmd' || ext === '.bat') {
      return { cmd: 'cmd.exe', args: ['/c', found, ...extraArgs] };
    }
    if (ext === '.ps1') {
      return {
        cmd: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', found, ...extraArgs],
      };
    }
    // .exe / no extension → spawn directly.
  }

  return { cmd: found, args: extraArgs };
}
