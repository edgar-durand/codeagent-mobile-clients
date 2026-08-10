import * as path from 'node:path';
import type { IPtyStrategy, PtyStrategyOptions } from '../services/pty/types';

/**
 * Per-OS strategy interface.
 *
 * The CLI runs on macOS (primary dev surface), Linux (Codespaces +
 * CI), and Windows (real users on cmd.exe / PowerShell / Windows
 * Terminal). Today, OS-specific behaviour is scattered as inline
 * `process.platform === 'win32'` branches in agent runtimes, services,
 * and commands. The audit catalogued 13 distinct branches across 9
 * files — exactly the leak this interface eliminates.
 *
 * **Contract.** Each method is a side-effect-free probe of the
 * host environment, OR an explicit pure transformation (path
 * concatenation, shell-arg escaping). Methods that genuinely require
 * spawning child processes / loading native modules (PTY creation,
 * shell installers, secret-store probes) are NOT yet on the
 * interface — those land in follow-up PRs (#51 PTY, #53 installer)
 * to keep this PR a no-behaviour-change refactor.
 *
 * Agent strategies will COMPOSE an OsStrategy in #50:
 * `class ClaudeRuntimeStrategy { constructor(readonly os: OsStrategy) }`.
 * Until that lands, the existing `process.platform` callsites can
 * adopt this interface one at a time without breaking the others.
 */
export interface OsStrategy {
  /** Stable id used for telemetry + structured logs. */
  readonly id: 'darwin' | 'linux' | 'win32';

  // ─── Filesystem layout ───────────────────────────────────────────

  /** `os.homedir()` wrapped so tests can stub. */
  homeDir(): string;

  /**
   * Per-process throwaway path under the OS temp dir, namespaced
   * by pid + caller prefix so concurrent CLI processes don't
   * trample each other's files. Caller is responsible for cleanup.
   */
  scratchPath(prefix: string): string;

  /** `/dev/null` on POSIX, `NUL` on Windows. */
  devNull(): string;

  // ─── PATH + shell discipline ─────────────────────────────────────

  /**
   * Scan PATH for an executable; returns the full resolved path or
   * null. Windows probes PATHEXT (.exe/.cmd/.bat/.ps1) and uses
   * F_OK because Windows has no Unix execute bits.
   */
  findInPath(name: string): string | null;

  /** Prepend dirs to `process.env.PATH` using the OS path delimiter. */
  augmentPath(dirs: string[]): void;

  /**
   * Quote a single arg for inclusion in a shell-string. Used at
   * the SSH-to-Linux-remote boundary (providers/*.ts) where we
   * can't avoid shell-string construction. Direct spawn paths
   * MUST use array args instead of this.
   */
  escapeShellArg(s: string): string;

  /**
   * Translate a resolved-by-findInPath binary path into a
   * `(cmd, args)` pair safe to hand to a raw spawn — including
   * ConPTY, which (unlike `child_process.spawn({ shell: true })`)
   * does NOT do its own PATH lookup or PATHEXT resolution.
   *
   * Cases:
   *   - POSIX `claude` binary  → spawn the absolute path directly.
   *   - Windows `claude.exe`   → spawn the absolute path directly.
   *   - Windows `claude.cmd`   → wrap with `cmd.exe /c <abs-path>`.
   *   - Windows `claude.bat`   → same as .cmd.
   *   - Windows `claude.ps1`   → wrap with
   *     `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <abs-path>`.
   *
   * Without the wrap on .cmd/.ps1, ConPTY surfaces a `File not
   * found:` error because it tries to execute the script directly
   * as a Win32 image. Anthropic's official Windows installer drops
   * a `claude.cmd` shim into PATH, which is exactly the case that
   * caused the v2.4.31 boot failure.
   */
  buildLaunch(binaryPath: string, extraArgs?: string[]): {
    cmd: string;
    args: string[];
  };

  /**
   * Return the prioritised list of PTY backends to attempt for this
   * OS. The caller (`AgentService.spawn`) walks the list in order,
   * calls `.spawn()` on each, and falls back to the next on
   * exception — typical Win32 path: ConPTY first (real terminal) →
   * pipe fallback when the vendored conpty.node fails to load
   * (AV quarantine, missing prebuild).
   *
   * Strategies that fail to **construct** are filtered out before
   * the list is returned (e.g. ConPTY require throws when the
   * native binding can't load). Strategies that fail at `.spawn()`
   * time are walked past by the caller. An empty list means PTY
   * is genuinely unavailable for the host — caller should surface
   * a clear error.
   *
   * The list is ALWAYS non-empty for supported platforms (we don't
   * want the empty-list ambiguity to silently produce a non-spawn).
   */
  createPtyStrategies(opts: PtyStrategyOptions): IPtyStrategy[];

  // ─── Power management ────────────────────────────────────────────

  /**
   * The OS-native command that PREVENTS the machine from going to idle /
   * system sleep while a LOCAL session runs, tied to `pid` so the assertion
   * auto-releases when that process exits (even on a hard crash — no leaked
   * "computer won't sleep"). A long-running local `codeam` session is frozen by
   * an idle laptop sleeping, which drops the paired mobile app until the user
   * physically wakes the machine; holding this assertion keeps it alive.
   *
   * Per-OS equivalent:
   *   - darwin → `caffeinate -i -s -w <pid>`
   *   - linux  → `systemd-inhibit --what=sleep:idle --mode=block tail --pid=<pid> -f /dev/null`
   *   - win32  → powershell `SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED)` + WaitForExit(<pid>)
   *
   * `null` when the OS exposes no such mechanism. Pure — returns the argv, spawns
   * nothing; `services/keep-awake.ts` owns the (best-effort) spawn + teardown.
   */
  keepAwakeCommand(pid: number): KeepAwakeCommand | null;
}

/** A `(cmd, args)` pair for a raw (array-args, no shell) spawn. */
export interface KeepAwakeCommand {
  cmd: string;
  args: string[];
}

// ─── Shared helpers (used by all concrete impls) ────────────────────

/**
 * Common findInPath impl — both Unix and Windows pivot on the same
 * algorithm with platform-specific candidate-extension + access-flag
 * sets. Pulled out so the per-platform impls stay one-liners.
 */
export function findInPathFor(
  name: string,
  opts: {
    candidates: (name: string) => string[];
    accessFlag: number;
    accessSync: (p: string, mode?: number) => void;
  },
): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const candidates = opts.candidates(name);
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      try {
        opts.accessSync(full, opts.accessFlag);
        return full;
      } catch {
        /* try next */
      }
    }
  }
  return null;
}
