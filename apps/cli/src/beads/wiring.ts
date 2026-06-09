import type { BeadsActionKind, BeadsActionPayload } from '@codeagent/shared';
import { startBeads, type StartedBeads } from './index';
import { deriveProjectIdentity } from './project-key';
import { postBeadsProvisioning } from '../services/pairing.service';
import { log } from '../services/logger';

/**
 * Composition-root entry for Beads (SRP decision D10). Invoked by the CLI's
 * shared start path — `start()` (local `codeam start` AND codespace
 * `pair-auto`→`start()`) and `startInfraOnly()` — as a SEPARATE, parallel,
 * strictly NON-FATAL concern alongside the agent. The agent runners
 * (`runAcpSession`) carry zero beads code.
 *
 * Beads is permanently ON. The only switch is the LOCAL kill-switch
 * `CODEAM_BEADS_DISABLED` (truthy → full no-op; the provisioner is never even
 * touched).
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
 * into the internal `BeadsActionPayload` (`{kind, …}`) the apply path consumes.
 * Returns null for an unknown / missing action so the dispatcher drops it
 * without spawning bd. (Field-level validation — e.g. claim requires an
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
