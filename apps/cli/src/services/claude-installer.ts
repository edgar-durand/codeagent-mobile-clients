import { spawn as spawnProcess } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { confirm, isCancel } from '@clack/prompts';
import { findInPath } from './pty/types';

/**
 * Auto-install Claude Code if it isn't on PATH.
 *
 * Used by ClaudeService.spawn() the first time someone runs
 * `codeam pair` on a clean machine. Instead of bailing with
 * "claude not found", we offer to run Anthropic's official installer
 * inline so pairing → first prompt is a single uninterrupted flow.
 *
 *   macOS/Linux  curl -fsSL https://claude.ai/install.sh | bash
 *   Windows      irm https://claude.ai/install.ps1 | iex
 *
 * The installer drops the binary into a per-user location and edits
 * the shell rc files. The running CLI process won't see those edits,
 * so after install we also prepend known install dirs to this
 * process's PATH and re-run findInPath() so spawn() can pick the
 * fresh binary up without a shell restart.
 */

/**
 * Common locations the official installers drop `claude` into.
 * Probed after the installer runs to cover the case where the
 * shell-rc PATH update hasn't been picked up by the running process.
 */
function probeInstallDirs(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return [
      path.join(home, '.claude', 'local'),
      path.join(home, 'AppData', 'Local', 'AnthropicClaude'),
      path.join(home, 'AppData', 'Local', 'Programs', 'AnthropicClaude'),
    ];
  }
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    '/usr/local/bin',
  ];
}

function isAvailable(): boolean {
  return findInPath('claude') !== null || findInPath('claude-code') !== null;
}

/**
 * Prepend known install dirs to the running process's PATH so
 * findInPath() sees the freshly-installed binary without requiring a
 * shell restart.
 */
function augmentPath(): void {
  const dirs = probeInstallDirs();
  const sep = path.delimiter;
  const current = process.env.PATH ?? '';
  const existing = new Set(current.split(sep).filter(Boolean));
  const additions = dirs.filter((d) => !existing.has(d));
  if (additions.length === 0) return;
  process.env.PATH = additions.join(sep) + sep + current;
}

function runInstaller(): Promise<boolean> {
  const isWindows = process.platform === 'win32';
  // stdio: 'inherit' so the installer's own progress UI streams
  // straight to the user's terminal — they see the same output they
  // would running it manually.
  const cmd = isWindows ? 'powershell.exe' : 'bash';
  const args = isWindows
    ? [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'irm https://claude.ai/install.ps1 | iex',
      ]
    : ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'];

  return new Promise((resolve) => {
    const proc = spawnProcess(cmd, args, { stdio: 'inherit' });
    proc.on('error', (err) => {
      console.error(`\n  ✗ Installer failed to launch: ${err.message}`);
      resolve(false);
    });
    proc.on('exit', (code) => {
      resolve(code === 0);
    });
  });
}

/**
 * Returns true if `claude` is on PATH (already installed, or
 * successfully installed during this call). Returns false if the
 * user declined the install prompt or the installer exited non-zero.
 */
export async function ensureClaudeInstalled(): Promise<boolean> {
  if (isAvailable()) return true;

  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  if (isInteractive) {
    const proceed = await confirm({
      message:
        'Claude Code is not installed on this machine. Install it now using the official installer?',
      initialValue: true,
    });
    if (isCancel(proceed) || proceed === false) return false;
  } else {
    console.log('\n  Claude Code not found — running the official installer...\n');
  }

  console.log(); // blank line so the installer header isn't glued to clack's tree
  const ok = await runInstaller();
  if (!ok) {
    console.error('\n  ✗ Claude Code installation failed. See the installer output above.');
    return false;
  }

  augmentPath();
  if (!isAvailable()) {
    console.error(
      '\n  ⚠ Claude Code installed but the binary is still not on PATH for this process.\n' +
        '    This usually means the installer registered a new directory that only takes\n' +
        '    effect in a fresh shell. Restart your terminal and run `codeam pair` again.',
    );
    return false;
  }
  return true;
}
