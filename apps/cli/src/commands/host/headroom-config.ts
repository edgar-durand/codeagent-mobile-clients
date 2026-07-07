// src/commands/host/headroom-config.ts
//
// Persistence for the Headroom on-disk state the supervisor and the CLI
// handlers share: ~/.codeam/headroom-config.json (write/read → child env)
// and the per-agent settings backup/restore around `headroom init`.
// Moved VERBATIM out of host-agent.ts (Phase 3 refactor) — only the
// import/export wiring changed. host-agent.ts re-exports the public surface.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { log } from '../../services/logger';
import { restrictToOwner } from '../../util/restrict-to-owner';

/**
 * Persisted Headroom config the supervisor writes on a successful deploy and
 * re-reads on every child spawn (resume / restart / fresh deploy). This is the
 * single source of truth for the child's HEADROOM_* env so reporting survives
 * a session resume or a supervisor restart (systemd / periodic self-update),
 * not just the fresh-deploy path.
 *
 * Path: `~/.codeam/headroom-config.json`. Shape:
 *   { "enabled": true, "agent": "claude", "ingestUrl": "https://…/savings" }
 */
export function headroomConfigPath(): string {
  return path.join(os.homedir(), '.codeam', 'headroom-config.json');
}

/** The on-disk Headroom config shape (mirrors {@link readHeadroomChildEnv}). */
export interface HeadroomConfig {
  enabled: boolean;
  /** Mapped headroom kind (`agentIdToHeadroomKind` output, e.g. `claude`). */
  agent?: string;
  /** Full savings ingest URL (POST target). */
  ingestUrl?: string;
  /** Whether a spend budget is active. Persisted so self-hosted restarts re-inject it. */
  budgetEnabled?: boolean;
  /** Budget ceiling in USD (e.g. `10`). Present only when `budgetEnabled` is true. */
  budgetUsd?: number;
  /** Budget reset period — mirrors `headroom proxy --budget-period`. */
  budgetPeriod?: 'hourly' | 'daily' | 'monthly';
}

/**
 * Persist the Headroom config atomically (write a temp file, then rename) so a
 * concurrent reader never sees a half-written file. Best-effort: a failure to
 * persist is logged and swallowed — it must NEVER break the deploy.
 *
 * Pass `enabled: false` (or no agent/ingestUrl) when Headroom did NOT set up
 * successfully so a later resume doesn't wrongly point the agent at a dead
 * proxy via {@link readHeadroomChildEnv}.
 */
export function persistHeadroomConfig(config: HeadroomConfig): void {
  try {
    const file = headroomConfigPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    restrictToOwner(file);
  } catch (err) {
    log.warn(
      'host-agent',
      `failed to persist headroom config (best-effort): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Map a headroom kind (`claude`/`codex`/`copilot`) to the agent settings file
 * that `headroom init --global` writes and that we back up before init so the
 * user's prior customisations survive a Headroom upgrade/re-init.
 */
function agentSettingsPath(kind: string): string | null {
  const home = os.homedir();
  if (kind === 'claude') return path.join(home, '.claude', 'settings.json');
  if (kind === 'codex') return path.join(home, '.codex', 'auth.json');
  if (kind === 'copilot') return path.join(home, '.config', 'github-copilot', 'hosts.json');
  return null;
}

/**
 * Copy the agent's settings file to `~/.codeam/headroom-backup-<kind>.json`
 * before `headroom init` so the user's customisations can be restored later.
 * Best-effort: a missing source file or write failure is logged and swallowed.
 */
export function backupAgentHeadroomConfig(kind: string): void {
  const src = agentSettingsPath(kind);
  if (!src) return;
  try {
    if (!fs.existsSync(src)) return;
    const dest = path.join(os.homedir(), '.codeam', `headroom-backup-${kind}.json`);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o600);
    log.info('host-agent', `headroom config backup: ${src} → ${dest}`);
  } catch (err) {
    log.warn(
      'host-agent',
      `headroom config backup failed (best-effort): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Restore the agent's settings file from `~/.codeam/headroom-backup-<kind>.json`.
 * Returns `true` when the backup existed and was copied back, `false` when no
 * backup was found (i.e. there was nothing to restore).
 * Best-effort: a write failure is logged and swallowed.
 */
export function restoreAgentHeadroomConfig(kind: string): boolean {
  const dest = agentSettingsPath(kind);
  if (!dest) return false;
  const src = path.join(os.homedir(), '.codeam', `headroom-backup-${kind}.json`);
  if (!fs.existsSync(src)) return false;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o600);
    log.info('host-agent', `headroom config restored: ${src} → ${dest}`);
    return true;
  } catch (err) {
    log.warn(
      'host-agent',
      `headroom config restore failed (best-effort): ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Read the persisted Headroom config and translate it into the HEADROOM_* env
 * the pair-auto child needs to start its savings reporter. This is invoked at
 * EVERY child spawn (fresh deploy AND resume / restart) so reporting survives
 * session resumes and supervisor restarts, not just the fresh-deploy path.
 *
 * Returns the 3 env vars only when the persisted config is `enabled` AND both
 * `agent` and `ingestUrl` are present non-empty strings. Otherwise (missing
 * file, bad JSON, disabled, or incomplete) returns `{}` so the child's
 * `maybeStartHeadroomReporter` no-ops and no dangling ANTHROPIC_BASE_URL is set.
 *
 * Best-effort: any read/parse error maps to `{}`. Exported for tests.
 */
export function readHeadroomChildEnv(): Record<string, string> {
  try {
    const raw = fs.readFileSync(headroomConfigPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const o = parsed as Record<string, unknown>;
    if (
      o.enabled === true &&
      typeof o.agent === 'string' &&
      o.agent.length > 0 &&
      typeof o.ingestUrl === 'string' &&
      o.ingestUrl.length > 0
    ) {
      const env: Record<string, string> = {
        HEADROOM_ENABLED: '1',
        HEADROOM_AGENT: o.agent,
        HEADROOM_SAVINGS_INGEST_URL: o.ingestUrl,
      };
      // Forward budget constraints so the proxy launch and savings reporter
      // pick them up on every child spawn / supervisor restart.
      // Read from the persisted config (not process.env) so self-hosted
      // supervisor restarts and reboots survive without the parent process env.
      if (
        o.budgetEnabled === true &&
        typeof o.budgetUsd === 'number'
      ) {
        env['HEADROOM_BUDGET'] = String(o.budgetUsd);
        env['HEADROOM_BUDGET_PERIOD'] =
          typeof o.budgetPeriod === 'string' ? o.budgetPeriod : 'daily';
      }
      return env;
    }
    return {};
  } catch {
    return {};
  }
}
