import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentId } from '@codeagent/shared';
import { BdAdapter, defaultBeadsHomeDir } from './bd-adapter';
import { installBd } from './install-bd';
import { installDolt, installDoltToDir, ensureDoltResolvable } from './install-dolt';
import { ensureSharedServer } from './dolt-daemon';
import { deriveProjectIdentity } from './project-key';
import { prefixForProjectKey } from './project-prefix';
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
  /** `dolt` is resolvable on PATH (required for memory; D15). */
  doltAvailable: boolean;
  /** The shared `dolt sql-server` is up after provisioning (D8/D15). */
  serverUp: boolean;
  /** The per-project shared-server database name we init'd / verified (D16). */
  prefix: string | null;
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
 * Seams so tests can drive the install fallbacks + the daemon + the project
 * identity without touching the real `~/.beads`, installing dolt, or spawning.
 */
export const _provisionSeam = {
  install: installBd,
  installDolt,
  /** No-sudo fallback: extract the dolt tarball/zip into a user-writable dir. */
  installDoltToDir,
  // Probe dolt on PATH AND auto-prepend a known install dir if found off-PATH
  // (codespace: official install.sh drops dolt in /usr/local/bin, which the
  // bundled-node CLI's PATH can omit — mirrors the bd-on-PATH symlink fix).
  doltOnPath: ensureDoltResolvable,
  ensureSharedServer,
  deriveProjectIdentity,
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
    // PREFER ~/.local/bin. In a codespace it is on the AGENT's persistent
    // login-shell PATH, whereas node's own bin (`dirname(process.execPath)`)
    // is the TRANSIENT bootstrap prefix (`/tmp/codeam-node20/bin`): on the
    // CLI process's PATH and writable, so the old ordering picked it FIRST —
    // but it is NOT on the agent's PATH, so the symlinked `bd` was
    // `command not found` in Claude Code's Bash tool (the bug this reorder
    // fixes, validated live 2026-06-13). Create ~/.local/bin first so the
    // writable check below accepts it even on a fresh codespace.
    if (localBin) {
      try {
        _linkSeam.ensureDir(localBin);
      } catch {
        /* fall through to the other candidates */
      }
    }
    const candidates: string[] = [];
    if (localBin) candidates.push(localBin);
    try {
      candidates.push(path.dirname(process.execPath));
    } catch {
      /* execPath unavailable */
    }
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

export async function provisionBeads(opts: ProvisionOptions = {}): Promise<ProvisionResult> {
  const bd = opts.adapter ?? new BdAdapter({ cwd: opts.cwd, beadsDir: opts.beadsDir });

  const result: ProvisionResult = {
    bdAvailable: false,
    doltAvailable: false,
    serverUp: false,
    prefix: null,
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

  // Step 2 — ensure `dolt`. The npm-bundled bd is the server-mode build, so
  // memory ops (remember/memories/prime) need the standalone dolt binary +
  // server (D15). On a missing binary, run the consented per-OS installer and
  // re-probe. Without dolt, beads can't deliver memory — bail non-fatally so
  // the agent still runs (issues+memory just won't be available this session).
  if (!_provisionSeam.doltOnPath()) {
    log.info('beads', 'dolt binary missing — running per-OS dolt installer');
    await _provisionSeam.installDolt(); // official (brew / sudo curl / MSI), non-fatal
  }
  if (!_provisionSeam.doltOnPath()) {
    // No-sudo fallback: the official install.sh needs root + /usr/local/bin,
    // which a locked-down container may not allow. Extract the official
    // tarball/zip into a user-writable, on-PATH dir (~/.local/bin in a
    // codespace) — no sudo. ensureDoltResolvable then finds it there and
    // prepends the dir to PATH.
    const dir = _linkSeam.cliBinDir();
    if (dir) {
      try {
        _linkSeam.ensureDir(dir);
      } catch {
        /* non-fatal — installDoltToDir's mkdir also creates it */
      }
      log.info('beads', `dolt still missing — no-sudo tarball fallback into ${dir}`);
      await _provisionSeam.installDoltToDir(dir);
    }
  }
  if (!_provisionSeam.doltOnPath()) {
    log.warn('beads', 'dolt unavailable after install + tarball fallback — beads memory disabled this run');
    return result;
  }
  result.doltAvailable = true;

  // Step 3 — init/verify the per-project prefix DB / workspace (D16). This MUST
  // run BEFORE starting the server: `bd dolt start` fails "no active beads
  // workspace found" with no initialized workspace (verified live in a
  // codespace — the v2.36.0 ordering bug). Per-repo isolation = unique prefix
  // (database name). Always pass our own `-p <prefix>` so we never inherit a
  // foreign `dolt_database` from a stray global config (D17). bd init is
  // idempotent: an already-initialized prefix returns an "already initialized"
  // notice (non-zero), which we treat as success. The actual Dolt database is
  // created lazily once the server is up + first written (verified).
  const { projectKey } = _provisionSeam.deriveProjectIdentity(opts.cwd);
  const prefix = prefixForProjectKey(projectKey);
  result.prefix = prefix;
  log.info('beads', `initializing shared-server prefix DB '${prefix}' (projectKey=${projectKey})`);
  const init = await bd.run([
    'init',
    '-p',
    prefix,
    '--shared-server',
    '--skip-agents',
    '--skip-hooks',
    '--non-interactive',
  ]);
  const alreadyInit = /already initialized|already exists/i.test(init.stderr + init.stdout);
  if (init.code !== 0 && !alreadyInit) {
    log.warn('beads', `bd init -p ${prefix} failed (code=${init.code}): ${init.stderr.slice(0, 200)}`);
    return result;
  }
  result.initialized = true;

  // Step 4 — ensure the shared dolt sql-server is up (D8), now that a workspace
  // exists for it. Reuse-if-running, else start detached. Without it, every
  // DB/memory op fails connection-refused.
  const server = await _provisionSeam.ensureSharedServer(bd);
  result.serverUp = server.up;
  if (!server.up) {
    log.warn('beads', 'shared dolt sql-server not up — beads disabled this run');
    return result;
  }

  // Step 4b — VERIFY the per-prefix DB actually EXISTS on the shared server,
  // self-healing it if not (the confirmed bug). `bd init --shared-server`
  // (Step 3) only sets up the LOCAL workspace/config; the server-side database
  // materializes lazily on first WRITE — but provisioning never writes (it only
  // starts the server, sets export.auto, runs bd setup), so on a clean/reset
  // server data dir the DB is NEVER created. Worse, an "already initialized"
  // LOCAL workspace (the alreadyInit branch in Step 3) was treated as proof the
  // server DB exists — it is not. The agent's first `bd create` then fails
  // "table not found: issues" and `issues.jsonl` / refs/dolt/data never appear.
  //
  // Probe with `bd ping` (resolves the workspace, opens the shared-server store,
  // runs a trivial issue-count query → exit 0 only when the DB is reachable).
  // When it fails, self-heal with a bootstrap-then-mint fallback:
  //
  //   1. `bd bootstrap` — bd's OWN recovery. It auto-detects `sync.remote`
  //      (derived from git origin) and CLONES the per-prefix DB from it, or
  //      restores a backup / git-tracked JSONL. CORRECT when the remote HAS
  //      Dolt data. But for a BRAND-NEW project the git remote has no
  //      `refs/dolt/data`, so bootstrap FAILS to produce a reachable DB (it
  //      does NOT fall through to "create fresh" because a remote IS
  //      configured) — so a bootstrap-only self-heal can never create the DB
  //      for a new project (the confirmed bug).
  //   2. Re-probe. If STILL unreachable, MINT a fresh local DB — the PROVEN
  //      new-project recovery (verified live: "Remote has no Dolt data yet;
  //      initialized a fresh local database" + `bd ping` → ok):
  //        bd init -p <prefix> --shared-server --reinit-local --discard-remote
  //                --destroy-token=DESTROY-<prefix> --non-interactive
  //      Safe here: the remote has no Dolt data (nothing to discard) and a
  //      brand-new project has no issues. The destroy-token format is
  //      `DESTROY-<issue-prefix>`; since WE control `-p <prefix>`, the
  //      issue-prefix IS that prefix — reuse the same `prefix` var for both.
  //   3. Re-probe once more and let `result.serverUp` / `result.initialized`
  //      reflect the FINAL probe — ACTUAL server-side DB presence, not just a
  //      local "already initialized" string.
  //
  // Strictly non-fatal + bounded (one bootstrap, one mint, probes between); a
  // throw degrades like the rest of this function rather than aborting the agent.
  try {
    if (!(await projectDbReachable(bd))) {
      log.info(
        'beads',
        `prefix DB '${prefix}' not reachable on shared server — self-healing via bd bootstrap`,
      );
      const boot = await bd.run(['bootstrap', '--non-interactive']);
      if (boot.code !== 0) {
        log.warn(
          'beads',
          `bd bootstrap failed (code=${boot.code}): ${boot.stderr.slice(0, 200)} — prefix DB may be absent`,
        );
      }

      // If bootstrap (clone/restore) didn't make the DB reachable, this is a
      // new project / empty remote → mint a fresh local DB.
      if (!(await projectDbReachable(bd))) {
        log.info(
          'beads',
          `prefix DB '${prefix}' still unreachable after bootstrap — minting a fresh local DB`,
        );
        const mint = await bd.run([
          'init',
          '-p',
          prefix,
          '--shared-server',
          '--reinit-local',
          '--discard-remote',
          `--destroy-token=DESTROY-${prefix}`,
          '--non-interactive',
        ]);
        if (mint.code !== 0) {
          log.warn(
            'beads',
            `bd init --reinit-local for '${prefix}' failed (code=${mint.code}): ${mint.stderr.slice(0, 200)} — prefix DB may be absent`,
          );
        }
      }

      const reachable = await projectDbReachable(bd);
      result.serverUp = reachable;
      result.initialized = reachable;
      if (!reachable) {
        log.warn(
          'beads',
          `prefix DB '${prefix}' still unreachable after bootstrap + mint — beads disabled this run`,
        );
        return result;
      }
      log.info('beads', `prefix DB '${prefix}' materialized on shared server`);
    }
  } catch (err) {
    log.warn('beads', 'verifying/creating the prefix DB threw (non-fatal)', err);
  }

  // Step 5 — enable the issues.jsonl auto-export change feed (idempotent).
  const exp = await bd.run(['config', 'set', 'export.auto', 'true']);
  result.exportEnabled = exp.code === 0;

  // Step 6 — wire each session agent natively (D12 — REVISED). `--check`-gated
  // + idempotent + strictly non-fatal (a throw / non-zero never aborts).
  result.agentsWired = await setupAgents(bd, opts.agents ?? []);

  log.info(
    'beads',
    `provision done dolt=${result.doltAvailable} server=${result.serverUp} prefix=${result.prefix} initialized=${result.initialized} export=${result.exportEnabled} agentsWired=[${result.agentsWired.join(',')}]`,
  );
  return result;
}

/**
 * Probe whether the per-prefix database is actually reachable on the shared
 * server. `bd ping` resolves the cwd workspace, opens the shared-server store,
 * and runs a trivial issue-count query — exit 0 ONLY when the DB exists and the
 * `issues` table is queryable (exactly what the agent's first `bd create`
 * needs). A clean/reset server data dir → the lazily-materialized DB is absent →
 * non-zero exit. Any thrown adapter is treated as "not reachable" so the caller
 * self-heals; the caller wraps this so it never aborts provisioning.
 */
async function projectDbReachable(bd: BdAdapter): Promise<boolean> {
  const ping = await bd.run(['ping']);
  return ping.code === 0;
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
      // Transient spawn ENOENT (the bundled bd native binary's postinstall
      // rename window) is retried at the adapter level (BdAdapter.run), so it
      // covers every bd call — init, dolt start, setup — not just this one.
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
