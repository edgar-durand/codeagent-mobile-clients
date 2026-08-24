// src/commands/host/self-update.ts
//
// Periodic npm self-update for the long-lived `codeam host-agent` systemd
// service: `npm view` the latest published codeam-cli, compare against the
// tsup-injected `__CLI_VERSION__`, `npm install -g` when strictly newer.
// Moved VERBATIM out of host-agent.ts (Phase 3 refactor) — only the
// import/export wiring changed. host-agent.ts re-exports the public surface.
import { execFile } from 'node:child_process';
import { log } from '../../services/logger';
import { compareSemver } from '../../lib/updateNotifier';

/**
 * Version string injected at build time by tsup's `define` (from the CLI's
 * own package.json — the same constant `version.ts` / `updateNotifier.ts`
 * read). The running self-hosted box compares THIS against npm's `latest`
 * to decide whether to self-update. Falls back to the literal `unknown`
 * under a non-tsup build (dev tests via tsx), which the compare treats as
 * "never newer" so a dev run can't trigger a self-update.
 */
declare const __CLI_VERSION__: string;

/** The npm package the host-agent ships in — the self-update target. */
const SELF_UPDATE_PKG = 'codeam-cli';

/**
 * Self-update cadence. Self-hosted boxes run `codeam host-agent` as a
 * long-lived systemd service (`Restart=always`), so they never pick up a
 * published fix on their own. On this interval the supervisor does a
 * best-effort `npm view <pkg> version`, and if a newer version is
 * published, `npm install -g <pkg>@latest` then exits so systemd
 * relaunches the new code. Override via `CODEAM_HOST_SELF_UPDATE_MS`; set
 * 0 (or negative) to DISABLE (tests / pinned boxes).
 */
export const SELF_UPDATE_INTERVAL_MS = 60 * 60 * 1000;

/** Timeout for the `npm view <pkg> version` registry lookup. */
const SELF_UPDATE_VIEW_TIMEOUT_MS = 30_000;

/** Timeout for the `npm install -g <pkg>@latest` install. */
const SELF_UPDATE_INSTALL_TIMEOUT_MS = 180_000;

/** Timeout for `npm ls -g` — purely local, no registry round-trip. */
const SELF_UPDATE_LS_TIMEOUT_MS = 15_000;

/** Timeout for the `sudo -n true` pre-flight. Non-interactive, so it either
 *  answers immediately or is refused immediately. */
const SUDO_PREFLIGHT_TIMEOUT_MS = 5_000;

/**
 * The current running CLI version, read from the tsup-injected
 * `__CLI_VERSION__` constant (single source of truth — same one
 * `version.ts` uses). Returns `null` when the define wasn't applied (dev
 * tests via tsx) so the self-update compare treats it as "never newer".
 */
function currentCliVersion(): string | null {
  return typeof __CLI_VERSION__ !== 'undefined' ? __CLI_VERSION__ : null;
}

/**
 * Outcome of one self-update check. `'updated'` means a strictly-newer
 * version was installed (the caller should restart). `'current'` means we
 * were already on the latest. `'skipped'` covers every best-effort failure
 * (registry/network/parse/install error) — the supervisor never crashes on
 * it. `version` carries the newly-installed version on `'updated'`.
 */
export interface SelfUpdateResult {
  status: 'updated' | 'current' | 'skipped';
  version?: string;
}

/**
 * Resolve the latest published version + self-update, injectable for tests.
 *
 * Contract: resolves to a {@link SelfUpdateResult}, NEVER rejects — every
 * failure maps to `'skipped'`. The default implementation shells out to npm
 * via {@link runSelfUpdate}; tests pass a deterministic mock so no real npm
 * runs and `process.exit` is never reached.
 */
export type SelfUpdater = () => Promise<SelfUpdateResult>;

/**
 * The three effects {@link runSelfUpdateWith} needs, injected so the decision
 * logic is testable without shelling out to npm or being root.
 */
export interface SelfUpdateDeps {
  run: (
    cmd: string,
    args: string[],
    timeoutMs: number,
  ) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** Version of the code CURRENTLY EXECUTING (build-time constant). */
  currentVersion: () => string | null;
  isRoot: () => boolean;
}

/**
 * Version of `codeam-cli` INSTALLED IN THE GLOBAL PREFIX — which is not
 * necessarily the version running. Local `npm ls`, no network, no privileges.
 * Returns null when the output can't be read or parsed, which the caller
 * treats as "no local answer" and falls through to the registry path.
 */
async function installedVersion(deps: SelfUpdateDeps): Promise<string | null> {
  const ls = await deps.run(
    'npm',
    ['ls', '-g', '--depth=0', '--json', SELF_UPDATE_PKG],
    SELF_UPDATE_LS_TIMEOUT_MS,
  );
  // `npm ls` exits non-zero on unmet peer deps while still printing valid
  // JSON, so parse regardless of the exit code and let the parse decide.
  try {
    const parsed = JSON.parse(ls.stdout) as {
      dependencies?: Record<string, { version?: string }>;
    };
    return parsed.dependencies?.[SELF_UPDATE_PKG]?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Run a command via execFile, resolving to `{ code, stdout, stderr }` on
 * completion/timeout — never rejects. Mirrors the best-effort, bounded
 * shape the Headroom runner uses. `cmd` is `npm` for the normal path and
 * `sudo` for the EACCES escalation retry (args then lead with `npm`).
 */
function runCmd(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      // execFile sets err.code to the exit status on a non-zero exit; on a
      // spawn error (npm missing) there's no numeric code — treat as null.
      const code =
        err && typeof (err as { code?: unknown }).code === 'number'
          ? (err as { code: number }).code
          : err
            ? null
            : 0;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

/**
 * Default self-updater: check npm for a newer `codeam-cli`, install it, and
 * report whether the version actually changed. Pure best-effort — any
 * failure resolves `'skipped'` and is logged at warn; it NEVER rejects so
 * the supervisor's self-update tick can't crash the process.
 *
 * Steps:
 *   1. `npm view codeam-cli version` (30s) → latest published version.
 *   2. Compare to the running `__CLI_VERSION__` via `compareSemver`. If not
 *      strictly newer → `'current'` (no install).
 *   3. `npm install -g codeam-cli@latest` (180s). The systemd unit runs as
 *      root so a global install works; if it fails with EACCES AND we're
 *      not already root, retry once with a `sudo` prefix.
 *   4. On a successful install, re-resolve the installed version and return
 *      `'updated'` with it (the caller restarts so systemd relaunches new code).
 */
export async function runSelfUpdate(): Promise<SelfUpdateResult> {
  return runSelfUpdateWith({
    run: runCmd,
    currentVersion: currentCliVersion,
    isRoot: () => process.getuid?.() === 0,
  });
}

export async function runSelfUpdateWith(deps: SelfUpdateDeps): Promise<SelfUpdateResult> {
  try {
    const current = deps.currentVersion();
    if (!current) {
      // No build-time version (dev/tsx) — can't reason about "newer". Skip.
      log.trace('host-agent', 'self-update: no __CLI_VERSION__ — skipping');
      return { status: 'skipped' };
    }

    // STEP 0 — is a newer build ALREADY on disk? We are not necessarily the
    // only thing that can update this package: fleet-1 runs four host-agents
    // off one npm global prefix, and the root one installs versions the
    // unprivileged three cannot. When that has happened there is nothing to
    // install — the process just needs to restart onto what is already there.
    // Skipping this check is what pinned the shared demo session on 2.65.16
    // for days while `/usr/bin/codeam --version` said 2.66.0, and logged 318
    // hourly EACCES failures for an install that was never needed
    // (codeagent-53em follow-up). Local, no network, no privileges.
    const onDisk = await installedVersion(deps);
    if (onDisk && compareSemver(onDisk, current) > 0) {
      log.info(
        'host-agent',
        `self-update: ${onDisk} already installed on disk (running ${current}) — restarting onto it`,
      );
      return { status: 'updated', version: onDisk };
    }

    const view = await deps.run(
      'npm',
      ['view', SELF_UPDATE_PKG, 'version'],
      SELF_UPDATE_VIEW_TIMEOUT_MS,
    );
    if (view.code !== 0) {
      log.trace('host-agent', `self-update: npm view exited ${String(view.code)} — skipping`);
      return { status: 'skipped' };
    }
    const latest = view.stdout.trim();
    if (!latest) {
      log.trace('host-agent', 'self-update: empty npm view output — skipping');
      return { status: 'skipped' };
    }

    // Only update on a strictly-newer published version.
    if (compareSemver(latest, current) <= 0) {
      return { status: 'current' };
    }

    log.info('host-agent', `self-update: ${current} → ${latest} available — installing`);
    const installArgs = ['install', '-g', `${SELF_UPDATE_PKG}@latest`];
    let install = await deps.run('npm', installArgs, SELF_UPDATE_INSTALL_TIMEOUT_MS);

    // EACCES + not-root → retry once under sudo (the global prefix needs
    // escalation on a box where host-agent isn't root, e.g. a dev box).
    //
    // ⚠️ PRE-FLIGHT `sudo -n true` FIRST. A host-agent running as an
    // unprivileged user inside a TTY-less systemd unit can never answer a
    // password prompt, so an un-preflighted `sudo npm install` can only burn
    // its full 180 s timeout and log a failure whose cause we already knew.
    // Same lesson, same fix as `ensurePythonInstaller` in the Headroom
    // provisioner.
    if (install.code !== 0 && !deps.isRoot() && /EACCES/i.test(install.stderr)) {
      const canSudo = await deps.run('sudo', ['-n', 'true'], SUDO_PREFLIGHT_TIMEOUT_MS);
      if (canSudo.code === 0) {
        log.info('host-agent', 'self-update: install hit EACCES — retrying with sudo');
        install = await deps.run('sudo', ['npm', ...installArgs], SELF_UPDATE_INSTALL_TIMEOUT_MS);
      } else {
        log.warn(
          'host-agent',
          'self-update: the npm global prefix is not writable by this user and passwordless ' +
            'sudo is unavailable — install codeam-cli under a user-writable prefix, or let a ' +
            'privileged agent on this host install it (this box restarts onto it automatically)',
        );
      }
    }

    if (install.code !== 0) {
      log.warn(
        'host-agent',
        `self-update: install exited ${String(install.code)} — staying on ${current}`,
      );
      return { status: 'skipped' };
    }

    // Confirm the install actually changed the on-disk version before we
    // tell the supervisor to restart (guards against a no-op install).
    const after = await deps.run(
      'npm',
      ['view', SELF_UPDATE_PKG, 'version'],
      SELF_UPDATE_VIEW_TIMEOUT_MS,
    );
    const installed = after.code === 0 ? after.stdout.trim() || latest : latest;
    return { status: 'updated', version: installed };
  } catch (err) {
    // Defensive — runNpm never rejects, but guard so the tick never throws.
    log.warn(
      'host-agent',
      `self-update: unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { status: 'skipped' };
  }
}
