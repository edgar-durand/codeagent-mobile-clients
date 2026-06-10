import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentId } from '@codeagent/shared';
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
 *   4. wire each session agent natively (D12 — REVISED 2026-06-10): for every
 *      agent in the session, `bd setup <recipe> --global`. This is the step
 *      that makes the agent actually USE bd — it registers the SessionStart
 *      hook globally in the agent's user-level settings (e.g.
 *      `~/.claude/settings.json`, runs `bd prime` each session) and appends a
 *      marked beads block to the cwd's CLAUDE.md NON-destructively (spike-
 *      verified against `@beads/bd@1.0.5`: pre-existing content is preserved).
 *      Without it the agent never runs `bd create`/`bd ready`, the graph stays
 *      empty, and the P0 mirror shows nothing. The earlier decision to skip it
 *      (the original D12) was wrong and is reverted here.
 *        • `--global`: registers at the user level so it covers every project,
 *          not just this cwd.
 *        • `--check`-gated: `bd setup <recipe> --global --check` reports install
 *          status; we skip the real setup when it's already installed
 *          (idempotent — re-running provisioning never re-wires).
 *        • strictly NON-FATAL: a setup failure (or a missing recipe for an
 *          agent bd doesn't ship) logs a warning and never aborts provisioning
 *          or the agent run.
 *
 * One-shot sequence the caller awaits — no timers, no polling.
 */

/**
 * Map a CodeAgent `AgentId` to the matching built-in `bd setup` recipe id.
 * `@beads/bd@1.0.5` ships recipes for `claude codex cursor windsurf junie
 * copilot gemini aider …`; for the agents we support the recipe id IS the
 * agent id — except `coderabbit`, which bd has no recipe for (→ null, skipped).
 */
const AGENT_SETUP_RECIPE: Record<AgentId, string | null> = {
  claude: 'claude',
  codex: 'codex',
  copilot: 'copilot',
  cursor: 'cursor',
  aider: 'aider',
  gemini: 'gemini',
  coderabbit: null,
};

export interface ProvisionOptions {
  /** Inject a pre-built adapter (tests / a shared instance). */
  adapter?: BdAdapter;
  /** Working dir bd resolves the repo prefix from (the user's project). */
  cwd?: string;
  /** Redirect the home brain off `~/.beads` (test isolation). */
  beadsDir?: string;
  /**
   * The agents in this session to wire natively via `bd setup <recipe>
   * --global` (D12). Empty / omitted (e.g. the no-agent codespace infra path)
   * → the setup step is a no-op.
   */
  agents?: AgentId[];
}

export interface ProvisionResult {
  /** bd was resolvable (bundled / PATH / freshly installed). */
  bdAvailable: boolean;
  /** The home brain exists (was already there, or freshly initialized). */
  initialized: boolean;
  /** `issues.jsonl` auto-export is enabled. */
  exportEnabled: boolean;
  /**
   * Recipe ids for which `bd setup <recipe> --global` is in place after this
   * run (freshly installed OR already present). Diagnostic only — a failed /
   * recipe-less agent is simply absent. Non-fatal: a setup failure never
   * affects the other result fields.
   */
  agentsWired: string[];
}

/**
 * Seams so tests can drive the install fallback + the on-disk init probe
 * without touching the real `~/.beads` or spawning a process.
 */
export const _provisionSeam = {
  install: installBd,
  homeBrainInitialized,
  /** GAP 1 — symlink the resolved bd onto PATH for the agent's own shell. */
  linkBdOntoPath,
  /** Silence bd's `beads.role not configured` warning. */
  setGitBeadsRole,
};

/**
 * Filesystem / environment primitives for the PATH symlink, isolated behind a
 * seam so tests drive idempotency without touching the real filesystem.
 */
export const _linkSeam = {
  platform: (): NodeJS.Platform => process.platform,
  homedir: (): string => os.homedir(),
  isWritableDir: (dir: string): boolean => {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
  ensureDir: (dir: string): void => {
    fs.mkdirSync(dir, { recursive: true });
  },
  /**
   * A directory to symlink `bd` into so the AGENT's shell + Claude Code's
   * SessionStart `bd prime` hook resolve `bd` by name. The dir MUST be on the
   * persistent shell PATH those processes use AND be writable.
   *
   * History: v2.35.1 used `dirname(realpath(argv[1]))` (the package `dist/`,
   * not on PATH); v2.35.2 used `dirname(process.execPath)` — correct for a
   * normal global npm install, but in a GitHub Codespace `node` lives in a
   * TRANSIENT bootstrap prefix (`/tmp/codeam-node20/bin`) that is NOT on the
   * persistent shell PATH, so the hook still failed (validated live). The
   * dir that IS on PATH and writable in a codespace is `~/.local/bin`.
   *
   * Strategy: among [node's bin, ~/.local/bin, /usr/local/bin, entry dir],
   * pick the first that is BOTH on `$PATH` AND writable. If none qualifies
   * (codespace: node prefix off-PATH, /usr/local/bin read-only), fall back to
   * `~/.local/bin` — the standard user bin, on PATH for login shells —
   * which `linkBdOntoPath` creates if missing.
   */
  cliBinDir: (): string | null => {
    const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    const home = _linkSeam.homedir();
    const localBin = home ? path.join(home, '.local', 'bin') : null;
    const candidates: string[] = [];
    try {
      candidates.push(path.dirname(process.execPath));
    } catch {
      /* execPath unavailable */
    }
    if (localBin) candidates.push(localBin);
    candidates.push('/usr/local/bin');
    const entry = process.argv[1];
    if (entry) {
      try {
        candidates.push(path.dirname(fs.realpathSync(entry)));
      } catch {
        candidates.push(path.dirname(entry));
      }
    }
    const onPathWritable = candidates.find(
      (d) => pathDirs.includes(d) && _linkSeam.isWritableDir(d),
    );
    if (onPathWritable) return onPathWritable;
    // Nothing on $PATH is writable — fall back to ~/.local/bin (created by
    // the caller). It's on PATH for login shells via the standard profile.
    return localBin ?? candidates[0] ?? null;
  },
  /** Current symlink target at `linkPath`, or null when absent / not a link. */
  readlink: (linkPath: string): string | null => {
    try {
      return fs.readlinkSync(linkPath);
    } catch {
      return null;
    }
  },
  unlink: (linkPath: string): void => fs.unlinkSync(linkPath),
  symlink: (target: string, linkPath: string): void => fs.symlinkSync(target, linkPath),
};

/**
 * GAP 1 — make `bd` resolvable in the AGENT's own shell. OUR adapter resolves
 * the bundled binary internally, but Claude Code runs `bd` in its Bash tool,
 * where the bundled binary isn't on PATH (`bd: command not found`) and the
 * SessionStart `bd prime` hook fails. Fix (validated live): symlink the
 * resolved binary as `bd` into the dir the `codeam` executable lives in — that
 * dir is already on PATH. Idempotent (skips when the link already points at the
 * binary, replaces a stale one). Linux/macOS only; Windows codespaces don't
 * exist so we no-op there. The caller wraps this in try/catch — strictly
 * non-fatal.
 */
function linkBdOntoPath(binaryPath: string): void {
  if (_linkSeam.platform() === 'win32') return; // codespaces are Linux
  const binDir = _linkSeam.cliBinDir();
  if (!binDir) return;
  // The chosen dir (e.g. the ~/.local/bin fallback) may not exist yet.
  _linkSeam.ensureDir(binDir);
  const linkPath = path.join(binDir, 'bd');
  if (linkPath === binaryPath) return; // bd already lives on PATH itself
  const current = _linkSeam.readlink(linkPath);
  if (current === binaryPath) return; // already correct — idempotent
  if (current !== null) _linkSeam.unlink(linkPath); // stale link → replace
  _linkSeam.symlink(binaryPath, linkPath);
  log.info('beads', `linked bd onto PATH: ${linkPath} -> ${binaryPath}`);
}

/**
 * Run `git config --global beads.role contributor` so bd stops warning
 * `beads.role not configured` in the agent's session output. Best-effort:
 * a missing git / non-zero exit is swallowed (the caller is non-fatal too).
 */
function setGitBeadsRole(): void {
  execFileSync('git', ['config', '--global', 'beads.role', 'contributor'], {
    stdio: 'ignore',
  });
}

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
    agentsWired: [],
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

  // GAP 1 — symlink the resolved bd onto PATH so the AGENT's own shell finds
  // it (our adapter resolves it internally, but Claude Code's Bash tool / the
  // `bd prime` SessionStart hook run `bd` directly). Strictly non-fatal.
  const binaryPath = bd.resolveBinary();
  if (binaryPath) {
    try {
      _provisionSeam.linkBdOntoPath(binaryPath);
    } catch (err) {
      log.warn('beads', 'linking bd onto PATH failed (non-fatal)', err);
    }
  }

  // Silence bd's `beads.role not configured` warning in the agent's output.
  // Best-effort — never aborts provisioning.
  try {
    _provisionSeam.setGitBeadsRole();
  } catch (err) {
    log.trace('beads', `git config beads.role failed (non-fatal): ${(err as Error).message}`);
  }

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

  // Step 4 — wire each session agent natively (D12 — REVISED). `--check`-gated
  // + idempotent + strictly non-fatal (a throw / non-zero never aborts).
  result.agentsWired = await setupAgents(bd, opts.agents ?? []);

  log.info(
    'beads',
    `provision done initialized=${result.initialized} export=${result.exportEnabled} agentsWired=[${result.agentsWired.join(',')}]`,
  );
  return result;
}

/**
 * Run `bd setup <recipe> --global` for each session agent (D12 — REVISED).
 * `--check`-gated so an already-wired recipe is skipped (idempotent), and
 * strictly non-fatal: any failure — a non-zero setup, a thrown adapter, or an
 * agent bd ships no recipe for — logs a warning and moves on without aborting
 * provisioning. Returns the recipe ids that are wired after this pass.
 */
async function setupAgents(bd: BdAdapter, agents: AgentId[]): Promise<string[]> {
  const wired: string[] = [];
  // De-dupe so a repeated agent doesn't run setup twice in one pass.
  for (const recipe of dedupeRecipes(agents)) {
    try {
      // `--check` reports install status: exit 0 → already wired, skip.
      const check = await bd.run(['setup', recipe, '--global', '--check']);
      if (check.code === 0) {
        log.trace('beads', `bd setup ${recipe} --global already installed — skipping`);
        wired.push(recipe);
        continue;
      }
      log.info('beads', `wiring agent natively: bd setup ${recipe} --global`);
      const setup = await bd.run(['setup', recipe, '--global']);
      if (setup.code === 0) {
        wired.push(recipe);
      } else {
        log.warn(
          'beads',
          `bd setup ${recipe} --global failed (code=${setup.code}): ${setup.stderr.slice(0, 200)} — non-fatal, agent runs without native bd wiring`,
        );
      }
    } catch (err) {
      // Strictly non-fatal — a setup throw must never abort provisioning or
      // the agent run.
      log.warn('beads', `bd setup ${recipe} --global threw (non-fatal)`, err);
    }
  }
  return wired;
}

/**
 * Map the session's agent ids to their de-duplicated `bd setup` recipe ids,
 * dropping agents bd ships no recipe for (e.g. coderabbit → null).
 */
function dedupeRecipes(agents: AgentId[]): string[] {
  const seen = new Set<string>();
  for (const agent of agents) {
    const recipe = AGENT_SETUP_RECIPE[agent];
    if (recipe) seen.add(recipe);
  }
  return [...seen];
}
