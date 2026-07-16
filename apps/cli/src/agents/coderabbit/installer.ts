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
    // `curl` gets connect/transfer caps AND the spawn gets an overall backstop.
    // Without them a hung download (common inside a locked-down fleet box with
    // restricted egress) never settles this promise → `configureCoderabbit`
    // never returns → the mobile app spins forever with no error. With the caps
    // a stall becomes a normal non-zero exit, which the caller reports.
    const INSTALL_TIMEOUT_MS = 150_000;
    const proc = spawn(
      'sh',
      ['-c', `curl -fsSL --connect-timeout 15 --max-time 120 ${INSTALL_URL} | sh`],
      { stdio: 'inherit' },
    );
    let settled = false;
    const finish = (v: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      console.error('\n  ✗ CodeRabbit install timed out — check network egress and retry.\n');
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already exited */
      }
      finish(false);
    }, INSTALL_TIMEOUT_MS);
    proc.on('close', (code) => finish(code === 0));
    proc.on('error', () => finish(false));
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
