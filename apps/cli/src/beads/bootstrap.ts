import type { AgentId } from '@codeagent/shared';
import { BdAdapter } from './bd-adapter';
import { log } from '../services/logger';

/**
 * Idempotent Beads bootstrap, run on `codeam pair` / codespace deploy (gated
 * behind the server-pushed `beads` flag — the caller checks the flag). Every
 * step probes-then-acts so a second run is a no-op:
 *
 *   1. Home brain — bd's `--global` shared DB (decision D2/§4.5). We poke it
 *      with `bd status --json --global`; bd lazily creates `beads_global` on
 *      first touch, so no explicit `init` is needed. A non-zero status here
 *      with the server down is expected and handled by step 2.
 *   2. Dolt sql-server — `bd dolt status`; if not running, `bd dolt start`
 *      DETACHED (cf. the codespace "detach pair-auto" lesson — a foreground
 *      daemon under SSH hits Vercel's 180 s timeout), then smoke-check with a
 *      second `bd dolt status`. bd owns the process (D4/D8); we only ensure
 *      it's up.
 *   3. Agent wiring — `bd setup <recipe> --check`; only run `bd setup <recipe>`
 *      when the check reports the recipe isn't installed. Reuses bd's built-in
 *      idempotent recipes (claude/codex/cursor/…) — we never hand-write
 *      instruction files.
 *   4. Auto-export — `bd config` to enable the `.beads/issues.jsonl` change
 *      feed the watcher tails.
 *
 * No timers, no polling — this is a one-shot sequence the caller awaits.
 */

export interface BootstrapOptions {
  /** Working dir bd resolves the repo prefix from (the user's project). */
  cwd?: string;
  /** Agents the user has — each gets `bd setup <recipe>`. */
  agents: AgentId[];
  /** Inject a pre-built adapter (tests / shared instance). */
  adapter?: BdAdapter;
  /** Test isolation — redirect bd off the real home brain. */
  beadsDir?: string;
}

export interface BootstrapResult {
  /** bd was resolvable (bundled or PATH). When false, nothing else ran. */
  bdAvailable: boolean;
  /** The dolt sql-server is up after bootstrap. */
  serverUp: boolean;
  /** Recipes that were freshly applied this run (empty on a repeat run). */
  agentsConfigured: AgentId[];
  /** issues.jsonl auto-export is enabled. */
  exportEnabled: boolean;
}

/**
 * bd's built-in `setup` recipe name per agent id. Only agents bd ships a
 * recipe for are mapped; an agent without a recipe is skipped (logged), never
 * hand-wired. bd recipes (verified in spike): claude codex cursor windsurf
 * junie copilot gemini aider …
 */
const SETUP_RECIPE: Partial<Record<AgentId, string>> = {
  claude: 'claude',
  codex: 'codex',
  cursor: 'cursor',
  gemini: 'gemini',
  aider: 'aider',
  copilot: 'copilot',
};

export async function bootstrapBeads(opts: BootstrapOptions): Promise<BootstrapResult> {
  const bd = opts.adapter ?? new BdAdapter({ cwd: opts.cwd, beadsDir: opts.beadsDir });

  const result: BootstrapResult = {
    bdAvailable: false,
    serverUp: false,
    agentsConfigured: [],
    exportEnabled: false,
  };

  if (!bd.isAvailable()) {
    log.warn('beads', 'bd binary unavailable — skipping bootstrap');
    return result;
  }
  result.bdAvailable = true;

  // Step 1 + 2: ensure the dolt sql-server backing the home brain is up.
  result.serverUp = await ensureServer(bd);
  if (!result.serverUp) {
    // Without the server, agent wiring + export config can't persist
    // reliably. Bail cleanly; the next heartbeat-driven bootstrap retries.
    log.warn('beads', 'dolt sql-server not up after start — skipping wiring this run');
    return result;
  }

  // Step 3: idempotent per-agent recipe setup.
  for (const agent of opts.agents) {
    const recipe = SETUP_RECIPE[agent];
    if (!recipe) {
      log.trace('beads', `no bd setup recipe for agent ${agent} — skipping`);
      continue;
    }
    const applied = await ensureRecipe(bd, recipe);
    if (applied) result.agentsConfigured.push(agent);
  }

  // Step 4: enable the issues.jsonl auto-export change feed.
  result.exportEnabled = await ensureAutoExport(bd);

  log.info(
    'beads',
    `bootstrap done server=${result.serverUp} agents=[${result.agentsConfigured.join(',')}] export=${result.exportEnabled}`,
  );
  return result;
}

/**
 * Ensure the dolt sql-server is running. `bd dolt status` exit 0 = already up
 * (reuse-if-running, the idempotent fast path). Non-zero → `bd dolt start`
 * (bd starts it detached), then re-check with `bd dolt status` as the
 * smoke-check.
 */
async function ensureServer(bd: BdAdapter): Promise<boolean> {
  const status = await bd.run(['dolt', 'status']);
  if (status.code === 0) {
    log.trace('beads', 'dolt sql-server already running');
    return true;
  }
  log.info('beads', 'dolt sql-server down — starting detached');
  const start = await bd.run(['dolt', 'start']);
  if (start.code !== 0) {
    log.warn('beads', `bd dolt start failed (code=${start.code}): ${start.stderr.slice(0, 200)}`);
    return false;
  }
  // Smoke-check — confirm the server actually accepts connections now.
  const recheck = await bd.run(['dolt', 'status']);
  return recheck.code === 0;
}

/**
 * Idempotent `bd setup <recipe>`. `--check` exits 0 when already installed →
 * no-op. Otherwise apply the recipe (bd's recipes are themselves idempotent,
 * but the check avoids rewriting the owned block on every bootstrap).
 * Returns true only when a fresh setup was applied this run.
 */
async function ensureRecipe(bd: BdAdapter, recipe: string): Promise<boolean> {
  const check = await bd.run(['setup', recipe, '--check']);
  if (check.code === 0) {
    log.trace('beads', `recipe ${recipe} already configured`);
    return false;
  }
  const setup = await bd.run(['setup', recipe]);
  if (setup.code !== 0) {
    log.warn('beads', `bd setup ${recipe} failed (code=${setup.code})`);
    return false;
  }
  log.info('beads', `configured agent recipe: ${recipe}`);
  return true;
}

/**
 * Enable auto-export of `.beads/issues.jsonl` after writes — the change feed
 * the watcher tails. `bd config` is idempotent (setting an already-set value
 * is a no-op). Returns true on exit 0.
 */
async function ensureAutoExport(bd: BdAdapter): Promise<boolean> {
  const res = await bd.run(['config', 'set', 'export.jsonl', 'true']);
  return res.code === 0;
}
