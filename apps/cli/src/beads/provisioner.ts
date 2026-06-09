import * as fs from 'fs';
import * as path from 'path';
import { BdAdapter, defaultBeadsHomeDir } from './bd-adapter';
import { installBd } from './install-bd';
import { log } from '../services/logger';

/**
 * Provision the home-level Beads "brain" — a composition-root concern (SRP
 * decision D10), NOT an agent-runner one. Called once by the CLI's shared
 * start path (`start()` + `startInfraOnly()`) as a parallel, strictly
 * non-fatal step alongside the agent. The agent runners carry zero beads code.
 *
 * The sequence is the one VERIFIED against `@beads/bd@1.0.5` in the spike
 * (2026-06-09), which corrected the earlier `--global` plan:
 *
 *   1. ensure-bd — resolve the bundled `@beads/bd` binary (or `bd` on PATH);
 *      if NEITHER resolves, run the consented OS installer (`install-bd`) and
 *      re-probe. We do NOT silently skip on a missing binary.
 *   2. init the HOME brain (idempotent) — `bd init --skip-agents --skip-hooks
 *      --non-interactive` rooted at `~/.beads` (addressed via `BEADS_DIR`).
 *        • NO `--global`: `--global` requires shared-server mode, which needs a
 *          standalone `dolt` binary on PATH that the bundled bd does not ship.
 *          The embedded home brain needs no external dolt.
 *        • `--skip-agents` is load-bearing for P0 (D12): it prevents bd from
 *          writing CLAUDE.md / AGENTS.md or a SessionStart hook into the cwd,
 *          so provisioning never disrupts the running agent's workspace.
 *        • Idempotent: re-running `bd init` over an existing brain ABORTS with
 *          a non-zero-intent message, so we probe for `~/.beads/embeddeddolt`
 *          first and skip init when the brain is already there.
 *   3. enable auto-export — `bd config set export.auto true` (the VERIFIED key;
 *      the earlier `export.jsonl` was wrong and silently no-op'd) so bd writes
 *      `~/.beads/issues.jsonl` after each mutation — the change feed the watcher
 *      tails.
 *
 * We do NOT run `bd setup <recipe>` here. That installs the per-agent
 * instruction-file wiring + SessionStart hook (P1 — Composer eats `bd prime`)
 * and is exactly what risks disrupting the agent. P0 is the read-only mirror.
 *
 * One-shot sequence the caller awaits — no timers, no polling.
 */

export interface ProvisionOptions {
  /** Inject a pre-built adapter (tests / a shared instance). */
  adapter?: BdAdapter;
  /** Working dir bd resolves the repo prefix from (the user's project). */
  cwd?: string;
  /** Redirect the home brain off `~/.beads` (test isolation). */
  beadsDir?: string;
}

export interface ProvisionResult {
  /** bd was resolvable (bundled / PATH / freshly installed). */
  bdAvailable: boolean;
  /** The home brain exists (was already there, or freshly initialized). */
  initialized: boolean;
  /** `issues.jsonl` auto-export is enabled. */
  exportEnabled: boolean;
}

/**
 * Seams so tests can drive the install fallback + the on-disk init probe
 * without touching the real `~/.beads` or spawning a process.
 */
export const _provisionSeam = {
  install: installBd,
  homeBrainInitialized,
};

/**
 * The home brain is initialized iff `<beadsDir>/embeddeddolt` exists — the
 * embedded Dolt engine dir `bd init` creates. Cheap fs probe (no spawn), and
 * reliable because `bd where` / `bd status` exit 0 even when uninitialized.
 */
function homeBrainInitialized(beadsDir: string): boolean {
  try {
    return fs.statSync(path.join(beadsDir, 'embeddeddolt')).isDirectory();
  } catch {
    return false;
  }
}

export async function provisionBeads(opts: ProvisionOptions = {}): Promise<ProvisionResult> {
  const bd = opts.adapter ?? new BdAdapter({ cwd: opts.cwd, beadsDir: opts.beadsDir });
  const beadsDir = opts.beadsDir ?? defaultBeadsHomeDir();

  const result: ProvisionResult = {
    bdAvailable: false,
    initialized: false,
    exportEnabled: false,
  };

  // Step 1 — ensure bd. On a missing binary, run the consented installer and
  // re-probe rather than skipping (the bootstrap that aborted in the codespace
  // left beads un-provisioned exactly because it gave up here).
  if (!bd.isAvailable()) {
    log.info('beads', 'bd binary missing — running OS installer fallback');
    const install = await _provisionSeam.install();
    if (!install.ok) {
      log.warn('beads', `bd install failed (code=${install.code}) — beads disabled this run`);
      return result;
    }
  }
  if (!bd.isAvailable()) {
    log.warn('beads', 'bd still unavailable after install — beads disabled this run');
    return result;
  }
  result.bdAvailable = true;

  // Step 2 — init the home brain (idempotent: skip when already present).
  if (_provisionSeam.homeBrainInitialized(beadsDir)) {
    log.trace('beads', `home brain already initialized at ${beadsDir}`);
    result.initialized = true;
  } else {
    log.info('beads', `initializing home brain at ${beadsDir}`);
    const init = await bd.run(['init', '--skip-agents', '--skip-hooks', '--non-interactive']);
    if (init.code !== 0) {
      log.warn('beads', `bd init failed (code=${init.code}): ${init.stderr.slice(0, 200)}`);
      return result;
    }
    result.initialized = true;
  }

  // Step 3 — enable the issues.jsonl auto-export change feed (idempotent).
  const exp = await bd.run(['config', 'set', 'export.auto', 'true']);
  result.exportEnabled = exp.code === 0;

  log.info(
    'beads',
    `provision done initialized=${result.initialized} export=${result.exportEnabled}`,
  );
  return result;
}
