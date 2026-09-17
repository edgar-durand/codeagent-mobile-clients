// src/commands/host/os-packages.ts
//
// Deteccion del gestor de paquetes del SO + las recetas de instalacion que le
// corresponden, con la abstraccion inyectable `OsRunner` que comparten.
// Salio VERBATIM de host-agent.ts (refactor de Fase 3); host-agent.ts
// re-exporta la superficie publica.

import { execFileSync, spawn } from 'node:child_process';
import { log } from '../../services/logger';
import { killQuiet } from '../../lib/quiet';

/**
 * Subprocess runner inyectable para el provisionamiento del box.
 *
 * `run` returns a Promise that resolves to `{ code, stderr }` on command
 * completion/timeout, never rejects. The `timeoutMs` bound is advisory —
 * the runner kills the child after that many milliseconds if it is still
 * running. Real subprocess output is captured via the default runner; tests
 * substitute a deterministic mock without forking.
 *
 * `which` synchronously checks whether a command is on PATH. The default
 * implementation shells out to `execFileSync('which', [cmd])`; tests inject
 * a lookup function so no real subprocess runs and ESM module boundaries are
 * never crossed.
 */
export interface OsRunner {
  run(
    cmd: string,
    args: string[],
    opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
  ): Promise<{ code: number | null; stderr: string; stdout?: string }>;
  /** Returns true when `cmd` is present on PATH, false otherwise. */
  which(cmd: string): boolean;
}

/** Timeout for the OS-level bare-box provision (python3+pip+ca-certificates+curl). */
const PM_INSTALL_TIMEOUT_MS = 180_000;

/**
 * Default subprocess runner backed by Node's `spawn` (for async commands)
 * and `execFileSync` (for synchronous `which` checks).
 * Streams stdout/stderr to the host-agent logger, waits for exit (or
 * timeout), and resolves — never rejects.
 */
export const defaultOsRunner: OsRunner = {
  which(cmd: string): boolean {
    try {
      execFileSync('which', [cmd], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  },
  run(cmd, args, opts = {}): Promise<{ code: number | null; stderr: string; stdout?: string }> {
    return new Promise((resolve) => {
      const spawnEnv = opts.env ?? process.env;
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv });
      let stderrBuf = '';
      let stdoutBuf = '';
      let settled = false;
      const done = (code: number | null): void => {
        if (settled) return;
        settled = true;
        // stdout MUST be returned (not just logged), not every caller only
        // wants the exit code — some parse the command's output.
        resolve({ code, stderr: stderrBuf, stdout: stdoutBuf });
      };

      child.stdout?.on('data', (b: Buffer) => {
        const chunk = b.toString();
        stdoutBuf += chunk;
        const line = chunk.replace(/\n+$/, '');
        if (line) log.info('host-agent', `os[${cmd}]: ${line}`);
      });
      child.stderr?.on('data', (b: Buffer) => {
        const chunk = b.toString();
        stderrBuf += chunk;
        const line = chunk.replace(/\n+$/, '');
        if (line) log.info('host-agent', `os[${cmd}]: ${line}`);
      });

      const timeoutMs = opts.timeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          log.warn(
            'host-agent',
            `os[${cmd}] timed out after ${timeoutMs / 1000}s — aborting`,
          );
          killQuiet(child);
          done(null);
        }, timeoutMs);
      }

      child.once('exit', (code) => {
        if (timer !== undefined) clearTimeout(timer);
        done(code);
      });
      child.once('error', (e) => {
        if (timer !== undefined) clearTimeout(timer);
        log.trace('host-agent', `os[${cmd}] spawn error: ${e.message}`);
        done(null);
      });
    });
  },
};

/**
 * Known OS package managers, in detection-preference order. apt/apk/dnf/yum
 * cover the bulk of Linux fleets; pacman (Arch) and zypper (openSUSE) are
 * checked last so the common distros short-circuit first.
 */
export type PackageManager = 'apt-get' | 'apk' | 'dnf' | 'yum' | 'pacman' | 'zypper';

const PACKAGE_MANAGERS: readonly PackageManager[] = [
  'apt-get',
  'apk',
  'dnf',
  'yum',
  'pacman',
  'zypper',
];

/**
 * Per-package-manager bare-box provision recipe. A bare box may have *nothing*,
 * so every recipe installs the full minimal toolchain que una instalacion pip
 * needs: a Python interpreter + pip, plus `ca-certificates` (without which the
 * PyPI TLS handshake fails) and `curl`.
 *
 * `update` (apt-get only) runs first and is treated as a soft failure — a stale
 * mirror shouldn't abort the install. `install` is the command + args that must
 * exit 0; `usesSudo` is always true here (every entry escalates when non-root).
 */
interface ProvisionRecipe {
  /** Optional pre-step (e.g. `apt-get update`); non-zero is non-fatal. */
  update?: string[];
  /** The install command + args (without sudo); must exit 0 to succeed. */
  install: string[];
}

const PROVISION_RECIPES: Record<PackageManager, ProvisionRecipe> = {
  'apt-get': {
    update: ['apt-get', 'update'],
    install: [
      'apt-get',
      'install',
      '-y',
      'python3',
      'python3-pip',
      'python3-venv',
      'ca-certificates',
      'curl',
    ],
  },
  apk: {
    install: ['apk', 'add', '--no-cache', 'python3', 'py3-pip', 'ca-certificates', 'curl'],
  },
  dnf: {
    install: ['dnf', 'install', '-y', 'python3', 'python3-pip', 'ca-certificates', 'curl'],
  },
  yum: {
    install: ['yum', 'install', '-y', 'python3', 'python3-pip', 'ca-certificates', 'curl'],
  },
  pacman: {
    install: ['pacman', '-Sy', '--noconfirm', 'python', 'python-pip', 'ca-certificates', 'curl'],
  },
  zypper: {
    install: [
      'zypper',
      '--non-interactive',
      'install',
      'python3',
      'python3-pip',
      'ca-certificates',
      'curl',
    ],
  },
};

/**
 * Detect the OS package manager available on this box, preferring faster /
 * more common package managers. Returns the first match from
 * {@link PACKAGE_MANAGERS} (apt-get → apk → dnf → yum → pacman → zypper), or
 * `null` when none are present so the caller can degrade gracefully.
 *
 * Detection delegates `which` to the supplied runner so tests can control
 * visibility without crossing ESM module boundaries.
 */
export function detectPackageManager(runner: Pick<OsRunner, 'which'>): PackageManager | null {
  for (const pm of PACKAGE_MANAGERS) {
    if (runner.which(pm)) return pm;
  }
  return null;
}

/**
 * Per-manager "install these package names" argv prefix (WITHOUT sudo). Kept
 * separate from {@link PROVISION_RECIPES} (which is the fixed
 * toolchain) so callers that need an ARBITRARY package — e.g. the CodeRabbit
 * installer's `unzip`/`git` prerequisites — can reuse the same manager
 * detection instead of hand-rolling a second table.
 */
const INSTALL_ARGV_PREFIX: Record<PackageManager, string[]> = {
  'apt-get': ['apt-get', 'install', '-y', '--no-install-recommends'],
  apk: ['apk', 'add', '--no-cache'],
  dnf: ['dnf', 'install', '-y'],
  yum: ['yum', 'install', '-y'],
  pacman: ['pacman', '-Sy', '--noconfirm'],
  zypper: ['zypper', '--non-interactive', 'install'],
};

/**
 * Build the (sudo-less) argv that installs `packages` with the given package
 * manager. Returns null when no manager was detected or no packages were
 * requested, so callers can degrade to an actionable "install it yourself"
 * message rather than guessing.
 */
export function osPackageInstallArgv(
  pm: PackageManager | null,
  packages: string[],
): string[] | null {
  if (pm === null || packages.length === 0) return null;
  return [...INSTALL_ARGV_PREFIX[pm], ...packages];
}
