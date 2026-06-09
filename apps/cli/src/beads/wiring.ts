import type { AgentId, BeadsActionKind, BeadsActionPayload } from '@codeagent/shared';
import { maybeStartBeads, type StartedBeads } from './index';
import { log } from '../services/logger';

/**
 * Live-session wiring for Beads. Sits between the CLI start path /
 * command-relay dispatch and the gated orchestrator (`./index`).
 *
 * Beads is permanently ON — there is no server-pushed flag transport.
 * The only switch is the LOCAL kill-switch `CODEAM_BEADS_DISABLED`
 * (truthy → full no-op, the orchestrator is never even touched).
 *
 * Everything here is strictly NON-FATAL to the CLI core: a bootstrap
 * throw / missing token / unavailable bd logs a warning and returns
 * null. It must never break pairing or the agent run.
 */

/** Truthy local kill-switch — beads becomes a complete no-op. */
function beadsKilled(): boolean {
  const v = process.env.CODEAM_BEADS_DISABLED;
  return !!v && v !== '0' && v.toLowerCase() !== 'false';
}

export interface BeadsSessionContext {
  sessionId: string;
  pluginId: string;
  /** The watcher authenticates `POST /api/beads/ingest` with this
   *  (`X-Plugin-Auth-Token`). The CLI has no user JWT — without a
   *  token beads can't authenticate, so it stays off. */
  pluginAuthToken?: string;
  agents: AgentId[];
  cwd?: string;
}

/**
 * Bootstrap Beads for a live paired session. Always-on (enabled:true)
 * unless the local kill-switch is set. Returns the live `StartedBeads`
 * (watcher + adapter) for `beads_action` routing + session teardown, or
 * null when beads didn't start (killed / no token / bootstrap failed /
 * bd unavailable). Never throws.
 */
export async function startBeadsForSession(
  ctx: BeadsSessionContext,
): Promise<StartedBeads | null> {
  if (beadsKilled()) {
    log.trace('beads', 'CODEAM_BEADS_DISABLED set — beads off for this session');
    return null;
  }
  // No plugin auth token → the ingest POST can't authenticate (the CLI
  // has no user JWT). Skip rather than start a watcher that 401s.
  if (!ctx.pluginAuthToken) {
    log.trace('beads', 'no pluginAuthToken on session — beads off');
    return null;
  }

  try {
    return await maybeStartBeads({
      enabled: true,
      sessionId: ctx.sessionId,
      pluginId: ctx.pluginId,
      pluginAuthToken: ctx.pluginAuthToken,
      agents: ctx.agents,
      cwd: ctx.cwd,
    });
  } catch (err) {
    // Strictly non-fatal — a beads bootstrap failure must never break
    // the agent run or pairing.
    log.warn('beads', 'startBeadsForSession failed (non-fatal)', err);
    return null;
  }
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
 * Translate a backend-relayed `beads_action` command payload
 * (`{action, args}`) into the internal `BeadsActionPayload`
 * (`{kind, …}`) the orchestrator's apply path consumes. Returns null
 * for an unknown / missing action so the dispatcher drops it without
 * spawning bd. (Field-level validation — e.g. claim requires an
 * issueId — is `buildBdArgs`' job downstream.)
 */
export function beadsActionFromPayload(
  payload: Record<string, unknown>,
): BeadsActionPayload | null {
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
