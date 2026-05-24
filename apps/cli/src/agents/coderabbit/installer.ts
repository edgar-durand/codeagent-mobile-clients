/**
 * Best-effort `coderabbit` binary installer.
 *
 * CodeRabbit's official install path is the curl|sh recipe from
 * https://cli.coderabbit.ai/install.sh. The runtime probes
 * `findInPath('coderabbit')` first and only invokes this on miss.
 *
 * Windows native is intentionally NOT supported — per the
 * CodeRabbit docs the CLI only runs in macOS / Linux / WSL. We
 * surface a clear error instead of letting users hit a downstream
 * spawn failure they can't act on.
 */

import { spawn } from 'node:child_process';
import type { OsStrategy } from '../../os';

const INSTALL_URL = 'https://cli.coderabbit.ai/install.sh';

export async function ensureCoderabbitInstalled(os: OsStrategy): Promise<boolean> {
  if (os.findInPath('coderabbit')) return true;

  if (os.id === 'win32') {
    // No Windows-native install; per CodeRabbit docs WSL is required.
    // Surface a clear message instead of fighting through PowerShell
    // approximations of the bash installer.
    console.error(
      '\n  ✗ CodeRabbit on Windows requires WSL.\n' +
        '    Install the CLI inside your WSL distribution\n' +
        '    (curl -fsSL https://cli.coderabbit.ai/install.sh | sh)\n' +
        '    then re-run `codeam link coderabbit` from WSL.\n',
    );
    return false;
  }

  // POSIX (macOS / Linux) install via the official bash recipe.
  // Stream stdio so the user sees curl progress + any install-time
  // prompts. The `|| true`-like fallback we don't bother with —
  // CodeRabbit's installer exits non-zero only on real failures,
  // which we report verbatim.
  console.log('\n  CodeRabbit CLI not found — installing via the official script…\n');
  const ok = await new Promise<boolean>((resolve) => {
    const proc = spawn('sh', ['-c', `curl -fsSL ${INSTALL_URL} | sh`], {
      stdio: 'inherit',
    });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
  if (!ok) return false;
  // The installer drops the binary into a per-user dir; if PATH
  // wasn't refreshed by the shell rc, augment it on the fly so the
  // post-install probe sees the binary without a terminal restart.
  // CodeRabbit drops to `~/.local/bin` on Linux + `/opt/homebrew/bin`
  // or `~/.local/bin` on macOS — probe both.
  os.augmentPath([`${os.homeDir()}/.local/bin`, '/opt/homebrew/bin']);
  return os.findInPath('coderabbit') !== null;
}
