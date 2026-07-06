import type { AgentId, BeadsActionKind, BeadsActionCommand } from '@codeam/shared';
import { startBeads, type StartedBeads } from './index';
import { deriveProjectIdentity } from './project-key';
import { postBeadsProvisioning } from '../services/pairing.service';
import { log } from '../services/logger';
import { readBeadsEnabled } from './config-store';

/**
 * Composition-root entry for Beads (SRP decision D10). Invoked by the CLI's
 * shared start path — `start()` (local `codeam start` AND codespace
 * `pair-auto`→`start()`) and `startInfraOnly()` — as a SEPARATE, parallel,
 * strictly NON-FATAL concern alongside the agent. The agent runners
 * (`runAcpSession`) carry zero beads code.
 *
 * Beads is ON by default. Two switches disable it: the LOCAL env kill-switch
 * `CODEAM_BEADS_DISABLED` (truthy → full no-op) and the persisted user preference
 * `readBeadsEnabled() === false` (written by `persistBeadsConfig({enabled:false})`).
 *
 * Everything here is strictly NON-FATAL to the CLI core: a provisioner throw /
 * missing token / unavailable bd logs a warning and returns null. It must never
 * break pairing or the agent run.
 *
 * After provisioning resolves, a `beads_provisioning` status is POSTed to the
 * backend (D13) so it can emit the matching UserEvent — itself non-fatal.
 */

/** Truthy local kill-switch — beads becomes a complete no-op. */
function beadsKilled(): boolean {
  const v = process.env.CODEAM_BEADS_DISABLED;
  return !!v && v !== '0' && v.toLowerCase() !== 'false';
}

export interface BeadsSessionContext {
  sessionId: string;
  pluginId: string;
  /** The watcher authenticates `POST /api/beads/ingest` and the provisioning
   *  signal with this (`X-Plugin-Auth-Token`). The CLI has no user JWT —
   *  without a token beads can't authenticate, so it stays off. */
  pluginAuthToken?: string;
  cwd?: string;
  /**
   * The agents in this session, wired natively via `bd setup <recipe>
   * --global` (D12). `start()` passes its single `session.agent`; the no-agent
   * `startInfraOnly()` path passes none, so the setup step is a no-op there.
   */
  agents?: AgentId[];
}

/**
 * Provision Beads for the composition root. Always-on unless the local
 * kill-switch is set or no pluginAuthToken is present. Returns the live
 * `StartedBeads` (watcher + adapter) for `beads_action` routing + teardown, or
 * null when beads didn't start. Never throws.
 */
export async function provisionBeadsForStart(
  ctx: BeadsSessionContext,
): Promise<StartedBeads | null> {
  if (beadsKilled()) {
    log.trace('beads', 'CODEAM_BEADS_DISABLED set — beads off this run');
    return null;
  }

  // Persisted user preference: `persistBeadsConfig({enabled:false})` wrote
  // `~/.codeam/beads-config.json`. Honor it before touching env or provisioning,
  // so a disabled run is a true no-op (same contract as the kill-switch above).
  if (readBeadsEnabled() === false) {
    log.trace('beads', 'beads disabled by persisted config — beads off this run');
    return null;
  }

  // GAP 2 (D15/D16) — export shared-server mode into THIS process's env
  // SYNCHRONOUSLY, before the agent spawns, so the agent (its Bash tool + the
  // `bd prime` SessionStart hook) inherits it and reaches the shared dolt
  // sql-server. Done after the kill-switch so a disabled run stays a no-op.
  // Non-interactive agent shells may not source ~/.bashrc, so the spawned env
  // — not a profile file — is the reliable carrier.
  //
  // Do NOT export BEADS_DIR: under shared-server the workspace is resolved from
  // the agent's CWD (the project's `.beads/`, pointing at this project's prefix
  // DB). Forcing BEADS_DIR=~/.beads makes `bd prime`/`bd dolt start` fail "no
  // active beads workspace found" (verified live). Strip any inherited stale
  // BEADS_DIR so it can't override cwd resolution for the agent either.
  delete process.env.BEADS_DIR;
  process.env.BEADS_DOLT_SHARED_SERVER = '1';

  // No plugin auth token → ingest + provisioning POSTs can't authenticate (the
  // CLI has no user JWT). Skip rather than start a watcher that 401s.
  if (!ctx.pluginAuthToken) {
    log.trace('beads', 'no pluginAuthToken — beads off');
    return null;
  }
  const pluginAuthToken = ctx.pluginAuthToken;

  let started: StartedBeads | null = null;
  try {
    started = await startBeads({
      sessionId: ctx.sessionId,
      pluginId: ctx.pluginId,
      pluginAuthToken,
      cwd: ctx.cwd,
      agents: ctx.agents,
    });
  } catch (err) {
    // Strictly non-fatal — a provisioning failure must never break the agent
    // run or pairing.
    log.warn('beads', 'provisionBeadsForStart failed (non-fatal)', err);
    started = null;
  }

  // Signal provisioning status to the backend (D13) — non-fatal. `ready` when
  // the watcher is live; `failed` otherwise (bd unavailable / init failed).
  const { projectKey } = deriveProjectIdentity(ctx.cwd);
  void postBeadsProvisioning({
    sessionId: ctx.sessionId,
    pluginId: ctx.pluginId,
    pluginAuthToken,
    status: started ? 'ready' : 'failed',
    projectKey,
  }).then((res) => {
    if (!res.ok) {
      log.trace('beads', `provisioning signal POST non-ok (status=${res.status}) — ignoring`);
    }
  });

  return started;
}

const ACTION_KINDS: ReadonlySet<string> = new Set<BeadsActionKind>([
  'claim',
  'close',
  'create',
  'remember',
]);

/** Raw `beads_action` command payload as relayed by the backend. */
interface RawBeadsActionPayload {
  action?: unknown;
  args?: unknown;
}

function isBeadsActionKind(v: unknown): v is BeadsActionKind {
  return typeof v === 'string' && ACTION_KINDS.has(v);
}

function strOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Translate a backend-relayed `beads_action` command payload (`{action, args}`)
 * into the `BeadsActionCommand` (`{kind, …}`) the apply path consumes.
 * Returns null for an unknown / missing action so the dispatcher drops it
 * without spawning bd. (Field-level validation — e.g. claim requires an
 * issueId — is `buildBdArgs`' job downstream.)
 */
export function beadsActionFromPayload(
  payload: Record<string, unknown>,
): BeadsActionCommand | null {
  const { action, args } = payload as RawBeadsActionPayload;
  if (!isBeadsActionKind(action)) return null;
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  return {
    kind: action,
    issueId: strOrUndefined(a.issueId),
    text: strOrUndefined(a.text),
    reason: strOrUndefined(a.reason),
    owner: strOrUndefined(a.owner),
    projectKey: strOrUndefined(a.projectKey),
  };
}
