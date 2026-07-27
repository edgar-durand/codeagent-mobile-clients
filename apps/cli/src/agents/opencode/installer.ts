/**
 * Best-effort on-demand installer for the `opencode` binary — LOCAL pair parity
 * with the codespace bootstrap (which installs via `OpencodeProvisioningStrategy`)
 * and the baked box image.
 *
 * When a user runs `codeam pair` with opencode selected but the CLI isn't
 * installed, the ACP adapter would otherwise spawn `opencode acp` and fail with a
 * raw `ENOENT — 'opencode' was not found on PATH`. Instead we run opencode's
 * official installer (`curl -fsSL https://opencode.ai/install | bash`), augment
 * PATH with the installer's target dir (`~/.opencode/bin`, NOT on the default
 * PATH), and re-probe — mirroring Kimi's `ensureKimiInstalled` /
 * CodeRabbit's `ensureCoderabbitInstalled`.
 *
 * opencode-specific — lives entirely in the opencode strategy; no shared code or
 * other agent is affected.
 */

import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from '../../services/logger';

const INSTALL_URL = 'https://opencode.ai/install';

function opencodeBinDir(): string {
  return join(process.env.OPENCODE_HOME || join(homedir(), '.opencode'), 'bin');
}

/** True only when a runnable `opencode` is on PATH — a `--version` that exits 0. */
function opencodeRuns(): boolean {
  const r = spawnSync('opencode', ['--version'], { stdio: 'ignore', timeout: 15_000 });
  return !r.error && r.status === 0;
}

/** Add the installer's target dir to THIS process's PATH so the immediate ACP
 *  spawn resolves `opencode` without a shell restart (the installer persists it
 *  to the shell rc, which a non-interactive spawn won't have sourced). */
function augmentPath(): void {
  const dir = opencodeBinDir();
  const parts = (process.env.PATH ?? '').split(':');
  if (!parts.includes(dir)) process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
}

async function runInstaller(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const proc = spawn('sh', ['-c', `curl -fsSL ${INSTALL_URL} | bash`], { stdio: 'inherit' });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

/**
 * Ensure a runnable `opencode` is on PATH, installing it on demand. Returns true
 * when `opencode` is (now) runnable, false when installation isn't possible/failed
 * (the caller then surfaces the normal not-found error). Best-effort — never throws.
 */
export async function ensureOpencodeInstalled(): Promise<boolean> {
  augmentPath(); // maybe it's already installed under ~/.opencode/bin, just off PATH
  if (opencodeRuns()) return true;

  if (process.platform === 'win32') {
    console.error(
      '\n  ✗ opencode on Windows requires WSL.\n' +
        `    Install it inside WSL (curl -fsSL ${INSTALL_URL} | bash)\n` +
        '    then re-run `codeam pair`.\n',
    );
    return false;
  }

  console.log('\n  opencode not found — installing via the official script…\n');
  const ok = await runInstaller();
  augmentPath();
  if (!ok) {
    log.warn('opencode', 'installer failed — opencode will be reported as not installed');
    return false;
  }
  return opencodeRuns();
}
