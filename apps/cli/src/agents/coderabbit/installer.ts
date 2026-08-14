/**
 * Best-effort `coderabbit` binary installer.
 *
 * CodeRabbit's official install path is the curl|sh recipe from
 * https://cli.coderabbit.ai/install.sh. The runtime probes
 * `findInPath('coderabbit')` first and only invokes this on miss.
 *
 * ⚠️ That script has HARD prerequisites it checks up front
 * (`check_required_tools`): **`unzip`** (the release artifact is a
 * `coderabbit-<os>-<arch>.zip`) and **`git`**. When either is missing it
 * prints `[ERROR] Missing required tools: - unzip` and exits 1 WITHOUT
 * installing anything. Slim container images and bare VPS hosts routinely
 * ship neither — which is why CodeRabbit "never worked" on those boxes while
 * it worked fine on the fleet box image (whose Dockerfile installs `unzip`).
 * So we provision the prerequisites ourselves before invoking the script:
 *
 *   1. already on PATH                       → nothing to do
 *   2. OS package manager (root / `sudo -n`) → install them
 *   3. `unzip` only, unprivileged            → a scratch-dir `unzip` shim
 *      backed by Python's stdlib `zipfile`, exported to the installer's
 *      child PATH ONLY (never written into the user's `~/.local/bin`, so it
 *      can't shadow a real `unzip` later)
 *   4. still missing                         → an actionable error naming the
 *      tool and the exact command to run
 *
 * ⚠️ The installer's stdout/stderr is CAPTURED, not `inherit`ed. Under the
 * supervised host-agent daemon there is no tty and no journal sink, so
 * `stdio: 'inherit'` sent the only diagnostic ("Missing required tools") to
 * /dev/null and the user got an opaque "CodeRabbit CLI could not be
 * installed". We now echo it to the logger AND return the real reason.
 *
 * Windows native is intentionally NOT supported — per the CodeRabbit docs the
 * CLI only runs in macOS / Linux / WSL. We surface a clear error instead of
 * letting users hit a downstream spawn failure they can't act on.
 */

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { OsStrategy } from '../../os';
import { log } from '../../services/logger';
import {
  defaultHeadroomRunner,
  detectPackageManager,
  osPackageInstallArgv,
  type HeadroomRunner,
} from '../../commands/host/os-packages';

const INSTALL_URL = 'https://cli.coderabbit.ai/install.sh';

/** Overall backstop for the curl|sh install (the curl caps are separate). */
const INSTALL_TIMEOUT_MS = 150_000;

/** Bound for the prerequisite package-manager install. */
const PREREQ_INSTALL_TIMEOUT_MS = 120_000;

/**
 * Tools `install.sh` hard-requires in its own `check_required_tools`. Keep in
 * sync with the script — a missing one aborts it before any download.
 */
const REQUIRED_TOOLS = ['unzip', 'git'] as const;

/**
 * Outcome of an install attempt. `error` is the ACTIONABLE reason — it is
 * surfaced verbatim to the user through `coderabbit_status.error`, so it must
 * name the real blocker (and the command that fixes it) rather than a generic
 * "could not be installed".
 */
export interface CoderabbitInstallResult {
  ok: boolean;
  error?: string;
}

export interface CoderabbitInstallDeps {
  /** Subprocess runner for the prerequisite probe/install (injected in tests). */
  runner?: HeadroomRunner;
  /** Run the curl|sh installer. Returns its exit code + combined output. */
  runInstallScript?: (env: NodeJS.ProcessEnv) => Promise<{ code: number | null; output: string }>;
  /**
   * Is the installed binary actually RUNNABLE (`coderabbit --version` exits 0)?
   * Only consulted when the installer exited non-zero — see the runnability
   * guard in {@link ensureCoderabbitInstalled}. Injected in tests so no real
   * subprocess is spawned.
   */
  runVersionProbe?: (binary: string, env: NodeJS.ProcessEnv) => boolean;
}

/**
 * Default runnability probe: `<binary> --version`, short timeout, output
 * discarded. Mirrors `kimiRuns()` in `../kimi/installer.ts` — a spawn error or
 * a non-zero/null status (a truncated binary SIGSEGVs → status null) means the
 * binary is not usable.
 */
function defaultRunVersionProbe(binary: string, env: NodeJS.ProcessEnv): boolean {
  const r = spawnSync(binary, ['--version'], { stdio: 'ignore', timeout: 15_000, env });
  return !r.error && r.status === 0;
}

function probeRuns(binary: string, env: NodeJS.ProcessEnv, deps: CoderabbitInstallDeps): boolean {
  const probe = deps.runVersionProbe ?? defaultRunVersionProbe;
  try {
    return probe(binary, env);
  } catch {
    return false;
  }
}

/**
 * Human-readable "install it yourself" hint for the detected package manager
 * (or a generic one when no manager is detectable).
 */
function manualInstallHint(runner: HeadroomRunner, tools: readonly string[]): string {
  const pkgs = tools.join(' ');
  const argv = osPackageInstallArgv(detectPackageManager(runner), [...tools]);
  return argv ? `\`sudo ${argv.join(' ')}\`` : `your package manager (e.g. \`${pkgs}\`)`;
}

/**
 * Write a throwaway `unzip` shim backed by Python's stdlib `zipfile` into a
 * scratch dir and return that dir. The shim covers exactly the invocation
 * `install.sh` makes — `unzip -q <archive> -d <dest>` — and is exported to the
 * installer's child process PATH only.
 *
 * Returns null when Python 3 isn't available (nothing to back the shim with).
 */
function writeUnzipShim(os: OsStrategy, runner: HeadroomRunner): string | null {
  const python = ['python3', 'python'].find((p) => runner.which(p));
  if (!python) return null;
  const dir = os.scratchPath('codeam-cr-prereq');
  const shim = path.join(dir, 'unzip');
  // POSIX sh: skip `-q` (quiet is the default for us), capture `-d <dest>`,
  // treat the first non-flag argument as the archive. `python -m zipfile -e`
  // is stdlib since 3.4 and preserves the archive's directory structure.
  const script = `#!/bin/sh
set -e
archive=""
dest="."
while [ $# -gt 0 ]; do
  case "$1" in
    -q|-o|-qq) shift ;;
    -d) dest="$2"; shift 2 ;;
    *) if [ -z "$archive" ]; then archive="$1"; fi; shift ;;
  esac
done
[ -n "$archive" ] || { echo "unzip shim: no archive given" >&2; exit 1; }
mkdir -p "$dest"
exec ${python} -m zipfile -e "$archive" "$dest"
`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(shim, script, { mode: 0o700 });
  chmodSync(shim, 0o700);
  return dir;
}

/**
 * Ensure `install.sh`'s prerequisites are satisfiable. Returns the extra PATH
 * entries the installer child needs (empty when everything is already on PATH),
 * or an actionable error when a prerequisite can't be provided.
 */
export async function ensureInstallPrerequisites(
  os: OsStrategy,
  deps: CoderabbitInstallDeps = {},
): Promise<{ ok: true; extraPath: string[] } | { ok: false; error: string }> {
  const runner = deps.runner ?? defaultHeadroomRunner;
  const missing = REQUIRED_TOOLS.filter((t) => os.findInPath(t) === null);
  if (missing.length === 0) return { ok: true, extraPath: [] };

  log.info(
    'coderabbit',
    `installer prerequisites missing: ${missing.join(', ')} — attempting to provision them`,
  );

  // 2. OS package manager. `sudo -n` (non-interactive) so an unprivileged box
  //    fails FAST instead of blocking on a password prompt nobody can answer
  //    from a headless daemon.
  const argv = osPackageInstallArgv(detectPackageManager(runner), [...missing]);
  if (argv) {
    const isRoot = process.getuid?.() === 0;
    const cmd = isRoot ? argv[0] : 'sudo';
    const args = isRoot ? argv.slice(1) : ['-n', ...argv];
    const r = await runner.run(cmd, args, { timeoutMs: PREREQ_INSTALL_TIMEOUT_MS });
    if (r.code !== 0) {
      log.warn(
        'coderabbit',
        `prerequisite install exited ${String(r.code)} — falling back to the unprivileged path`,
      );
    }
  }

  const stillMissing = REQUIRED_TOOLS.filter((t) => os.findInPath(t) === null);
  if (stillMissing.length === 0) return { ok: true, extraPath: [] };

  // 3. Unprivileged fallback — we can substitute `unzip` (Python stdlib), but
  //    NOT `git`; the script shells out to real git operations.
  if (stillMissing.length === 1 && stillMissing[0] === 'unzip') {
    const shimDir = writeUnzipShim(os, runner);
    if (shimDir) {
      log.info('coderabbit', 'unzip is unavailable — using a scoped python zipfile shim');
      return { ok: true, extraPath: [shimDir] };
    }
  }

  // 4. Honest, actionable terminal error.
  const list = stillMissing.join(' and ');
  return {
    ok: false,
    error:
      `CodeRabbit's installer needs ${list} on this machine, and it couldn't be installed ` +
      `automatically (no root / no passwordless sudo). Install it with ` +
      `${manualInstallHint(runner, stillMissing)} and try again.`,
  };
}

/** Default install-script runner: `curl … | sh` with capped connect/transfer. */
function defaultRunInstallScript(
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    // `curl` gets connect/transfer caps AND the spawn gets an overall backstop.
    // Without them a hung download (common inside a locked-down fleet box with
    // restricted egress) never settles this promise → `configureCoderabbit`
    // never returns → the mobile app spins forever with no error.
    const proc = spawn(
      'sh',
      ['-c', `curl -fsSL --connect-timeout 15 --max-time 120 ${INSTALL_URL} | sh`],
      { stdio: ['ignore', 'pipe', 'pipe'], env },
    );
    let output = '';
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output });
    };
    const onData = (b: Buffer): void => {
      const chunk = b.toString();
      output += chunk;
      const line = chunk.replace(/\n+$/, '');
      if (line) log.info('coderabbit', `install: ${line}`);
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already exited */
      }
      output += '\ninstall timed out';
      finish(null);
    }, INSTALL_TIMEOUT_MS);
    proc.on('close', (code) => finish(code));
    proc.on('error', (e) => {
      output += `\n${e.message}`;
      finish(null);
    });
  });
}

/**
 * Strip ANSI colour codes and pick the most useful line out of the installer's
 * combined output so the user sees CodeRabbit's OWN diagnosis (e.g. "Missing
 * required tools: - unzip") rather than a generic failure.
 */
export function summarizeInstallFailure(output: string): string | null {
  // ⚠️ Written as an explicit \u001b escape, NOT a raw ESC byte — an invisible
  // control char in source is one reformat away from silently disappearing.
  // eslint-disable-next-line no-control-regex
  const clean = output.replace(/\u001b\[[0-9;]*m/g, '');
  const lines = clean
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const err = lines.find((l) => /\[ERROR\]|^error[: ]/i.test(l));
  if (err) {
    // Fold the follow-on "  - unzip" bullets into the ERROR line so the
    // single-line surface still names the missing tool.
    const idx = lines.indexOf(err);
    const bullets = lines.slice(idx + 1).filter((l) => l.startsWith('- '));
    const detail = bullets.length > 0 ? ` ${bullets.join(', ')}` : '';
    return `${err.replace(/^\[ERROR\]\s*/, '')}${detail}`.trim();
  }
  return lines.length > 0 ? lines[lines.length - 1] : null;
}

export async function ensureCoderabbitInstalled(
  os: OsStrategy,
  deps: CoderabbitInstallDeps = {},
): Promise<CoderabbitInstallResult> {
  if (os.findInPath('coderabbit')) return { ok: true };

  if (os.id === 'win32') {
    // No Windows-native install; per CodeRabbit docs WSL is required.
    return {
      ok: false,
      error:
        'CodeRabbit on Windows requires WSL. Install the CLI inside your WSL distribution ' +
        '(curl -fsSL https://cli.coderabbit.ai/install.sh | sh), then try again.',
    };
  }

  const prereq = await ensureInstallPrerequisites(os, deps);
  if (!prereq.ok) return { ok: false, error: prereq.error };

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (prereq.extraPath.length > 0) {
    env.PATH = [...prereq.extraPath, process.env.PATH ?? ''].filter(Boolean).join(':');
  }

  log.info('coderabbit', 'CodeRabbit CLI not found — installing via the official script');
  const run = deps.runInstallScript ?? defaultRunInstallScript;
  const { code, output } = await run(env);

  // The installer drops the binary into a per-user dir; if PATH wasn't
  // refreshed by the shell rc, augment it on the fly so the post-install probe
  // sees the binary without a terminal restart. CodeRabbit drops to
  // `~/.local/bin` on Linux + `/opt/homebrew/bin` or `~/.local/bin` on macOS —
  // probe both.
  os.augmentPath([`${os.homeDir()}/.local/bin`, '/opt/homebrew/bin']);
  const binary = os.findInPath('coderabbit');
  const detail = summarizeInstallFailure(output);

  // ⚠️ THE BINARY — not the vendor script's exit code — is the authority on
  // whether the install worked. CodeRabbit's `install.sh` (0.7.2) exits **2**
  // on a completely successful install: it prints "[SUCCESS] Installation
  // verified" / "[SUCCESS] Installation complete", leaves a working
  // ~/.local/bin/coderabbit, and still returns non-zero (reproduced on both
  // linux-amd64 and linux-arm64 by the real-install gate,
  // `__tests__/integration/agent-install.int.test.ts`). Gating on the exit
  // code first meant every user with a perfectly good install was told
  // "CodeRabbit CLI install failed: [SUCCESS] Installation complete".
  if (binary !== null) {
    // Clean exit → presence is enough (unchanged behavior).
    if (code === 0) return { ok: true };
    // Non-zero exit → presence alone is NOT enough. `findInPath` only checks
    // X_OK, so an interrupted download that left a truncated binary looks
    // identical to a healthy one. When the script told us something went
    // wrong, the authority is RUNNABILITY, not existence — the same guard
    // Kimi's install snippet applies (`kimi --version` after install; a
    // truncated ~157 MB ELF SIGSEGVs on every invocation). Only a binary that
    // actually answers `--version` clears a non-zero exit.
    if (probeRuns(binary, env, deps)) return { ok: true };
    return {
      ok: false,
      error: detail
        ? `CodeRabbit CLI install failed and the installed binary does not run: ${detail}`
        : "CodeRabbit CLI install failed — the installed `coderabbit` binary does not run. Re-run the install and check this machine's network egress.",
    };
  }

  if (code !== 0) {
    return {
      ok: false,
      error: detail
        ? `CodeRabbit CLI install failed: ${detail}`
        : "CodeRabbit CLI install failed — check this machine's network egress and try again.",
    };
  }
  return {
    ok: false,
    error: detail
      ? `CodeRabbit CLI install did not produce a binary: ${detail}`
      : 'CodeRabbit CLI install reported success but no `coderabbit` binary was found on PATH.',
  };
}
