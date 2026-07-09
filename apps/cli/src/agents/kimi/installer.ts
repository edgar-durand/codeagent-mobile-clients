/**
 * Best-effort on-demand installer for the `kimi` binary — LOCAL pair parity with
 * the codespace bootstrap (which installs via `KimiProvisioningStrategy`).
 *
 * When a user runs `codeam pair` with Kimi selected but the CLI isn't installed,
 * the ACP adapter would otherwise spawn `kimi acp` and fail with a raw
 * `ENOENT — 'kimi' was not found on PATH`. Instead we run Moonshot's official
 * curl installer (same recipe the codespace uses), augment PATH with the
 * installer's target dir (`~/.kimi-code/bin`, which is NOT on the default PATH),
 * and re-probe — mirroring CodeRabbit's `ensureCoderabbitInstalled`.
 *
 * Kimi-specific — lives entirely in the Kimi strategy; no shared code or other
 * agent is affected.
 */

import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from '../../services/logger';

const INSTALL_URL = 'https://code.kimi.com/kimi-code/install.sh';

function kimiBinDir(): string {
  return join(process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code'), 'bin');
}

/** True only when a runnable `kimi` is on PATH — a `--version` that exits 0.
 *  A truncated/partial install SIGSEGVs (status null), so this also rejects a
 *  broken binary, not just a missing one. */
function kimiRuns(): boolean {
  const r = spawnSync('kimi', ['--version'], { stdio: 'ignore', timeout: 15_000 });
  return !r.error && r.status === 0;
}

/** Add the installer's target dir to THIS process's PATH so the immediate ACP
 *  spawn resolves `kimi` without a shell restart (the installer persists it to
 *  ~/.bashrc, which a non-interactive spawn won't have sourced). */
function augmentPath(): void {
  const dir = kimiBinDir();
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
 * Ensure a runnable `kimi` is on PATH, installing it on demand. Returns true when
 * `kimi` is (now) runnable, false when installation isn't possible/failed (the
 * caller then surfaces the normal not-found error). Best-effort — never throws.
 */
export async function ensureKimiInstalled(): Promise<boolean> {
  augmentPath(); // maybe it's already installed under ~/.kimi-code/bin, just off PATH
  if (kimiRuns()) return true;

  if (process.platform === 'win32') {
    console.error(
      '\n  ✗ Kimi Code CLI on Windows requires WSL.\n' +
        `    Install it inside WSL (curl -fsSL ${INSTALL_URL} | bash)\n` +
        '    then re-run `codeam pair`.\n',
    );
    return false;
  }

  console.log('\n  Kimi Code CLI not found — installing via the official script…\n');
  let ok = await runInstaller();
  augmentPath();
  // The ~157MB download can land truncated (SIGSEGV) on a flaky connection —
  // same failure the codespace guard catches. Re-install once if it won't run.
  if (ok && !kimiRuns()) {
    log.warn('kimi', 'installed binary does not run (partial download?) — re-installing once');
    ok = await runInstaller();
    augmentPath();
  }
  if (!ok) {
    log.warn('kimi', 'installer failed — Kimi will be reported as not installed');
    return false;
  }
  return kimiRuns();
}
