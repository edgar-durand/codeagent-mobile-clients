// src/commands/host/os-packages.ts
//
// OS-level provisioning for Headroom's Python toolchain: package-manager
// detection + bare-box install recipes (`ensurePip`), and Python >=3.10
// resolution / auto-install (`resolveHeadroomPython` / `ensureModernPython`),
// plus the injectable `HeadroomRunner` subprocess abstraction they share.
// Moved VERBATIM out of host-agent.ts (Phase 3 refactor) — only the
// import/export wiring changed. host-agent.ts re-exports the public surface.
import { execFileSync, spawn } from 'node:child_process';
import { log } from '../../services/logger';

/**
 * Subprocess runner injectable for `setupHeadroomForSelfHosted`.
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
export interface HeadroomRunner {
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
export const defaultHeadroomRunner: HeadroomRunner = {
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
        // stdout MUST be returned (not just logged) — callers like
        // resolveHeadroomPython parse it (e.g. the `python --version` probe).
        resolve({ code, stderr: stderrBuf, stdout: stdoutBuf });
      };

      child.stdout?.on('data', (b: Buffer) => {
        const chunk = b.toString();
        stdoutBuf += chunk;
        const line = chunk.replace(/\n+$/, '');
        if (line) log.info('host-agent', `headroom[${cmd}]: ${line}`);
      });
      child.stderr?.on('data', (b: Buffer) => {
        const chunk = b.toString();
        stderrBuf += chunk;
        const line = chunk.replace(/\n+$/, '');
        if (line) log.info('host-agent', `headroom[${cmd}]: ${line}`);
      });

      const timeoutMs = opts.timeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          log.warn(
            'host-agent',
            `headroom[${cmd}] timed out after ${timeoutMs / 1000}s — aborting`,
          );
          try {
            child.kill('SIGTERM');
          } catch {
            /* already dead */
          }
          done(null);
        }, timeoutMs);
      }

      child.once('exit', (code) => {
        if (timer !== undefined) clearTimeout(timer);
        done(code);
      });
      child.once('error', (e) => {
        if (timer !== undefined) clearTimeout(timer);
        log.trace('host-agent', `headroom[${cmd}] spawn error: ${e.message}`);
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
 * so every recipe installs the full minimal toolchain Headroom's pip install
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
export function detectPackageManager(runner: Pick<HeadroomRunner, 'which'>): PackageManager | null {
  for (const pm of PACKAGE_MANAGERS) {
    if (runner.which(pm)) return pm;
  }
  return null;
}

/**
 * Prefix a command + args with `sudo` only when NOT running as root. Shared by
 * the bare-box provision (`ensurePip`) and the modern-Python auto-install
 * (`ensureModernPython`) so the sudo policy lives in exactly one place.
 */
function escalateCommand(argv: string[]): { cmd: string; args: string[] } {
  const isRoot = process.getuid?.() === 0;
  return isRoot ? { cmd: argv[0], args: argv.slice(1) } : { cmd: 'sudo', args: argv };
}

/**
 * Ensure pip is available. Fast path: if `pip` or `pip3` already resolves on
 * PATH, return true immediately — a box that has pip almost certainly already
 * has python3, ca-certificates, and curl too, so we do NOT run any
 * package-manager install (no `apt-get update` on every healthy deploy).
 *
 * Only when pip is ABSENT do we treat the box as bare and run the full
 * provision via the detected package manager — installing python3 + pip
 * alongside `ca-certificates` (PyPI TLS) and `curl`. Best-effort and bounded:
 * a missing package manager or a failed install returns false. Never throws.
 */
export async function ensurePip(runner: HeadroomRunner): Promise<boolean> {
  // Fast path: pip or pip3 is already on PATH → skip the bare-box provision.
  if (runner.which('pip') || runner.which('pip3')) {
    return true;
  }

  // pip is absent → assume a bare box and provision the full minimal toolchain.
  const pm = detectPackageManager(runner);
  if (!pm) {
    log.warn(
      'host-agent',
      'pip is absent and no known package manager (apt-get/apk/dnf/yum/pacman/zypper) found — skipping Headroom',
    );
    return false;
  }

  // Prefix each command with sudo only when NOT running as root.
  const escalate = escalateCommand;

  const recipe = PROVISION_RECIPES[pm];
  log.info(
    'host-agent',
    `pip absent — provisioning bare box (python3+pip+ca-certificates+curl) via ${pm}`,
  );

  try {
    // Optional update step (apt-get): non-zero is a soft failure (stale mirror).
    if (recipe.update) {
      const { cmd, args } = escalate(recipe.update);
      const updateResult = await runner.run(cmd, args, { timeoutMs: PM_INSTALL_TIMEOUT_MS });
      if (updateResult.code !== 0) {
        log.warn(
          'host-agent',
          `${pm} update exited ${String(updateResult.code)} — attempting install anyway`,
        );
      }
    }

    const { cmd, args } = escalate(recipe.install);
    const installResult = await runner.run(cmd, args, { timeoutMs: PM_INSTALL_TIMEOUT_MS });
    if (installResult.code !== 0) {
      log.warn(
        'host-agent',
        `${pm} bare-box provision failed (code=${String(installResult.code)}) — skipping Headroom`,
      );
      return false;
    }
  } catch (e) {
    // Unexpected error (should never happen with the runner contract, but guard anyway).
    log.warn(
      'host-agent',
      `bare-box provision threw unexpectedly: ${e instanceof Error ? e.message : String(e)} — skipping Headroom`,
    );
    return false;
  }

  log.info('host-agent', `bare box provisioned via ${pm} (python3+pip+ca-certificates+curl)`);
  return true;
}

/**
 * Probe candidates for a Python interpreter that meets headroom-ai's minimum
 * version requirement (≥3.10, the oldest abi3 wheel tag headroom-ai ships).
 *
 * On macOS the bare `python3` resolves to Xcode's Python 3.9.6 (pip 21.2.4),
 * which has no headroom-ai wheel (`Could not find a version that satisfies the
 * requirement`). The same box may have `/opt/homebrew/bin/python3.13` that
 * installs fine. We therefore probe version-suffixed binaries FIRST (newest
 * first) so the newest available modern interpreter wins, then fall back to
 * bare `python3` ONLY when it is itself ≥3.10.
 *
 * Probe order:
 *   1. Version-suffixed on PATH: python3.13 → python3.12 → python3.11 → python3.10
 *   2. Common absolute locations (macOS Homebrew arm64 + Intel + Linux):
 *      /opt/homebrew/bin/<suffix> and /usr/local/bin/<suffix>, same suffix order.
 *   3. Bare `python3` (accepted only when its reported version is ≥3.10).
 *
 * Returns the first qualifying binary string, or null when none is found.
 * Best-effort: a probe that errors or times out just skips that candidate.
 * Never throws.
 */
export async function resolveHeadroomPython(runner: HeadroomRunner): Promise<string | null> {
  /** Short probe timeout — we're just asking for a version string. */
  const PROBE_TIMEOUT_MS = 5_000;

  /** Suffixed variants to try, newest first (highest minor wins). */
  const SUFFIXES = ['python3.13', 'python3.12', 'python3.11', 'python3.10'] as const;

  /** Absolute prefix directories to check alongside PATH. */
  const PREFIX_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'] as const;

  /**
   * Probe a single candidate binary. Returns true when it is Python ≥3.10
   * AND has a usable `pip` — both are required to install headroom-ai. The pip
   * check matters because the NEWEST python on a box can be a pip-less minimal
   * build (e.g. a distro's `python3.13-minimal` pulled as a transitive apt dep)
   * while an older-but-complete `python3.12` has pip; we must pick the latter.
   */
  const probe = async (candidate: string): Promise<boolean> => {
    try {
      const r = await runner.run(
        candidate,
        ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'],
        { timeoutMs: PROBE_TIMEOUT_MS },
      );
      if (r.code !== 0) return false;
      const parts = (r.stdout ?? '').trim().split('.');
      const major = parseInt(parts[0] ?? '', 10);
      const minor = parseInt(parts[1] ?? '', 10);
      if (!(major === 3 && minor >= 10)) return false;
      // Require a working pip on THIS interpreter — `<py> -m pip --version`.
      const pipCheck = await runner.run(candidate, ['-m', 'pip', '--version'], {
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      return pipCheck.code === 0;
    } catch {
      return false;
    }
  };

  // 1. Version-suffixed on PATH (PATH-resolved; no absolute prefix).
  for (const suffix of SUFFIXES) {
    try {
      if (await probe(suffix)) return suffix;
    } catch {
      /* skip */
    }
  }

  // 2. Absolute locations for each suffix (macOS Homebrew arm64 + Intel + Linux).
  for (const suffix of SUFFIXES) {
    for (const dir of PREFIX_DIRS) {
      const candidate = `${dir}/${suffix}`;
      try {
        if (await probe(candidate)) return candidate;
      } catch {
        /* skip */
      }
    }
  }

  // 3. Bare `python3` — accepted only when it is itself ≥3.10.
  try {
    if (await probe('python3')) return 'python3';
  } catch {
    /* skip */
  }

  return null;
}

/** Generous bound for an OS package-manager / brew Python install (cold mirror
 *  + a fat python3.12 package can take a while). Matches the bare-box budget. */
const PY_INSTALL_TIMEOUT_MS = 600_000;

/**
 * Per-package-manager modern-Python install recipes, in attempt order. The
 * detection itself is reused from {@link detectPackageManager} — we only map a
 * manager to the package name(s) to try here. A version-suffixed package is
 * preferred where the manager ships one (apt's `python3.12`, dnf's `python3.12`)
 * so a box stuck on an old system python3 still gets a ≥3.10 interpreter; we
 * fall back to the unversioned package when no suffixed one exists. Each entry
 * is a list of `install` argv (without sudo); they are tried in order until one
 * exits 0. Best-effort: a failed install is non-fatal (we re-resolve after).
 */
const MODERN_PYTHON_RECIPES: Record<PackageManager, string[][]> = {
  'apt-get': [
    ['apt-get', 'install', '-y', 'python3.12'],
    ['apt-get', 'install', '-y', 'python3.11'],
    ['apt-get', 'install', '-y', 'python3'],
  ],
  dnf: [
    ['dnf', 'install', '-y', 'python3.12'],
    ['dnf', 'install', '-y', 'python3'],
  ],
  yum: [
    ['yum', 'install', '-y', 'python3.12'],
    ['yum', 'install', '-y', 'python3'],
  ],
  apk: [['apk', 'add', '--no-cache', 'python3']],
  pacman: [['pacman', '-Sy', '--noconfirm', 'python']],
  zypper: [
    ['zypper', '--non-interactive', 'install', 'python311'],
    ['zypper', '--non-interactive', 'install', 'python3'],
  ],
};

/**
 * Resolve a Python ≥3.10 interpreter for Headroom, AUTO-INSTALLING a modern
 * Python when none is present rather than skipping. Wraps
 * {@link resolveHeadroomPython}:
 *
 *   1. If a ≥3.10 interpreter already exists, return it immediately (no install).
 *   2. Otherwise attempt a best-effort, bounded install of a modern Python:
 *      • macOS: `brew install python@3.12` when `brew` is on PATH (Homebrew
 *        drops it at /opt/homebrew/bin or /usr/local/bin — both already probed
 *        by resolveHeadroomPython). No brew → no safe auto-install, fall through.
 *      • Linux: reuse {@link detectPackageManager} + {@link escalateCommand}
 *        (the same PM detection + sudo policy as `ensurePip`) and run the
 *        per-manager modern-Python recipe (versioned package preferred).
 *      • Any other platform: no install.
 *   3. Re-run resolveHeadroomPython and return its result (the freshly-installed
 *      interpreter, or null when the install didn't yield a ≥3.10 Python).
 *
 * Best-effort throughout — never throws. Returns the interpreter string or null.
 */
export async function ensureModernPython(runner: HeadroomRunner): Promise<string | null> {
  // 1. Already have a qualifying interpreter — no install needed.
  let py = await resolveHeadroomPython(runner);
  if (py !== null) return py;

  // 2. No ≥3.10 Python found → attempt a best-effort install.
  try {
    if (process.platform === 'darwin') {
      if (runner.which('brew')) {
        log.info('host-agent', 'no Python ≥3.10 found — installing python@3.12 via Homebrew');
        const r = await runner.run('brew', ['install', 'python@3.12'], {
          timeoutMs: PY_INSTALL_TIMEOUT_MS,
        });
        if (r.code !== 0) {
          log.warn(
            'host-agent',
            `brew install python@3.12 exited ${String(r.code)} — will re-probe anyway`,
          );
        }
      } else {
        log.warn(
          'host-agent',
          'no Python ≥3.10 and Homebrew is absent — cannot auto-install Python on macOS',
        );
      }
    } else if (process.platform === 'linux') {
      const pm = detectPackageManager(runner);
      if (!pm) {
        log.warn(
          'host-agent',
          'no Python ≥3.10 and no known package manager (apt-get/apk/dnf/yum/pacman/zypper) — cannot auto-install Python',
        );
      } else {
        log.info('host-agent', `no Python ≥3.10 found — installing a modern Python via ${pm}`);
        for (const argv of MODERN_PYTHON_RECIPES[pm]) {
          const { cmd, args } = escalateCommand(argv);
          const r = await runner.run(cmd, args, { timeoutMs: PY_INSTALL_TIMEOUT_MS });
          if (r.code === 0) {
            log.info('host-agent', `installed Python package via ${pm}: ${argv.join(' ')}`);
            break;
          }
          log.warn(
            'host-agent',
            `${pm} install '${argv.join(' ')}' exited ${String(r.code)} — trying next`,
          );
        }
      }
    } else {
      log.warn(
        'host-agent',
        `no Python ≥3.10 and platform '${process.platform}' has no auto-install path`,
      );
    }
  } catch (e) {
    // The runner contract never rejects, but guard anyway — best-effort.
    log.warn(
      'host-agent',
      `Python auto-install threw unexpectedly (best-effort): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // 3. Re-resolve after the install attempt — newly-installed interpreter or null.
  py = await resolveHeadroomPython(runner);
  return py;
}
