/**
 * In-session agent switch (`switch_agent` relay command) — orchestration.
 *
 * Swaps the running ACP agent (e.g. claude → codex) inside a LIVE session:
 *   1. validate the target (known id, ACP-capable, not the current agent);
 *   2. pull the user's vaulted credential (+ install script) via the
 *      session-authenticated provision-credential endpoint and write it with
 *      the same per-agent provisioners the self-hosted deploy uses;
 *   3. ensure the target's launch binary exists (baked images skip this);
 *   4. restart the ACP client on the new adapter (`session/new` — the prior
 *      conversation CANNOT be loaded cross-agent; context travels via the
 *      bounded handoff preamble the runner prefixes to the first post-switch
 *      prompt);
 *   5. persist + re-announce so mobile, heartbeats, and future restarts all
 *      agree on the new agent.
 *
 * Progress/status events mirror the `headroom_configure` discipline: POSTs
 * are serialized on a local chain so the backend republishes them strictly
 * in emit order; the terminal ack still rides the command relay.
 *
 * On ANY failure after the old client stopped, the deps revert to the prior
 * agent (baton `switchDriver` precedent) — the session must never wedge
 * mid-switch.
 */
import {
  AGENT_REGISTRY,
  isKnownAgentId,
  type AgentAuth,
  type AgentId,
  type SwitchAgentResult,
  type SwitchAgentStatus,
  type SwitchAgentStep,
} from '@codeam/shared';
import { log } from '../../services/logger';
import { runAgentInstallScript } from '../../commands/host/agent-install';
import { getAcpAdapter, requiresAcp } from './adapters';

/** Public agent ids that can never be a switch target. */
const NON_SWITCHABLE: ReadonlySet<string> = new Set([
  // Review-only reviewer — added to a session, never the primary agent.
  'coderabbit',
]);

/** Human display name for error copy; falls back to the raw id. */
function displayName(id: string): string {
  return isKnownAgentId(id) ? (AGENT_REGISTRY[id]?.displayName ?? id) : id;
}

/**
 * Validate a raw `switch_agent` payload agent id. Returns the typed id or a
 * human-readable refusal. Exported for the mobile-side contract tests.
 */
export function resolveSwitchTarget(
  raw: unknown,
  currentAgent: AgentId,
): { ok: true; agentId: AgentId } | { ok: false; error: string } {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, error: 'switch_agent: missing agentId' };
  }
  if (!isKnownAgentId(raw)) {
    return { ok: false, error: `Unknown agent "${raw}".` };
  }
  if (NON_SWITCHABLE.has(raw)) {
    return { ok: false, error: `${displayName(raw)} is a reviewer — it can't drive a session.` };
  }
  if (!requiresAcp(raw)) {
    return {
      ok: false,
      error: `${displayName(raw)} can't be switched to in a live session yet.`,
    };
  }
  if (raw === currentAgent) {
    return { ok: false, error: `${displayName(raw)} is already this session's agent.` };
  }
  return { ok: true, agentId: raw };
}

/** Map the provision-credential response onto the provisioners' AgentAuth. */
export function toAgentAuth(method: 'api_key' | 'oauth', credential: string): AgentAuth {
  return { kind: method === 'api_key' ? 'api_key' : 'oauth_token', value: credential };
}

/**
 * Ensure the target agent's launch binary is available, running the
 * backend-provided install script when it isn't. Uses the adapter's OWN
 * `waitForBinary` probe (per-agent: SDK-bundled claude, PATH codex/gemini,
 * absolute-path cursor). Baked images resolve instantly — zero delay on the
 * happy path.
 */
export async function ensureAgentBinaryForSwitch(
  agentId: AgentId,
  installScript: string | undefined,
  deps: {
    resolveAdapter?: typeof getAcpAdapter;
    runInstall?: typeof runAgentInstallScript;
  } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const resolveAdapter = deps.resolveAdapter ?? getAcpAdapter;
  const runInstall = deps.runInstall ?? runAgentInstallScript;
  const spec = resolveAdapter(agentId);
  if (!spec) {
    return { ok: false, error: `${displayName(agentId)} ACP adapter is unavailable on this CLI.` };
  }
  // Fast probe — instant when the binary is already present (baked images).
  if (await spec.waitForBinary({ timeoutMs: 2_000 })) return { ok: true };
  if (!installScript) {
    return {
      ok: false,
      error: `${displayName(agentId)} CLI is not installed on this machine.`,
    };
  }
  log.info('switchAgent', `installing ${agentId} binary (missing on PATH)`);
  const res = await runInstall(installScript, { logScope: 'switchAgent' });
  if (!res.ok) {
    return {
      ok: false,
      error: res.timedOut
        ? `${displayName(agentId)} install timed out.`
        : `${displayName(agentId)} install failed.`,
    };
  }
  // The installer exited 0 — give the PATH/package probe a short window to
  // observe the binary (npm -g bin links land asynchronously on some FSes).
  if (await spec.waitForBinary({ timeoutMs: 30_000 })) return { ok: true };
  return {
    ok: false,
    error: `${displayName(agentId)} installed but its binary never appeared on PATH.`,
  };
}

/**
 * Handoff preamble prefixed to the FIRST prompt after a switch, so the new
 * agent inherits the session's context (owner requirement: a switch must
 * never start cold). Pure; bounded by the caller-supplied transcript.
 */
export function buildHandoffPreamble(
  fromAgent: AgentId,
  toAgent: AgentId,
  transcript: string,
): string | null {
  const trimmed = transcript.trim();
  if (trimmed.length === 0) return null;
  // Same agent = the revert path relaunched the prior agent on a fresh
  // conversation — still hand its own context back, with honest copy.
  const takeover =
    fromAgent === toAgent
      ? `[Session handoff] You (${displayName(toAgent)}) are resuming a live coding session after a restart. `
      : `[Session handoff] You (${displayName(toAgent)}) are taking over a live coding session previously driven by ${displayName(fromAgent)}. `;
  return [
    takeover,
    `The conversation below is context from that session — continue the work seamlessly from where it left off. `,
    `Do not re-introduce yourself or re-do completed work.\n\n`,
    `--- Recent conversation with ${displayName(fromAgent)} ---\n`,
    `${trimmed}\n`,
    `--- End of handoff context ---`,
  ].join('');
}

// ─── Orchestration ──────────────────────────────────────────────────────────

/**
 * Everything the switch needs from its owner (the ACP runner). Coarse
 * closures so the state machine + event ordering are unit-testable with
 * fakes, while the runner keeps ownership of its swappable locals.
 */
export interface SwitchAgentDeps {
  currentAgent(): AgentId;
  /** Serialized event POST — callers get strict emit-order on the wire. */
  postEvent(
    type: 'switch_agent_progress' | 'switch_agent_status',
    payload: Record<string, unknown>,
  ): Promise<unknown>;
  fetchCredential(
    agentId: AgentId,
  ): Promise<{ method: 'api_key' | 'oauth'; credential: string; installScript?: string } | null>;
  /** Write the credential with the per-agent provisioner. Throws on failure. */
  provisionCredential(agentId: AgentId, auth: AgentAuth): void;
  ensureBinary(
    agentId: AgentId,
    installScript: string | undefined,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * Stop the old client and bring the new agent fully up (cancel in-flight
   * turn → flush streaming → capture handoff → new adapter + client +
   * runtime/history rebuild → banner). Throws on failure — the orchestrator
   * then calls {@link revertRuntime}.
   */
  swapRuntime(agentId: AgentId): Promise<void>;
  /** Best-effort relaunch of the PRIOR agent after a failed swap. */
  revertRuntime(agentId: AgentId): Promise<void>;
  /** Persist the new agent to ~/.codeam/config.json (session row). */
  persistAgent(agentId: AgentId): void;
  /** relay.setAgentMeta + reannounceAgents with the new agent. */
  reannounce(agentId: AgentId): void;
}

/** Build a serialized emitter over a raw poster (headroom emit-chain shape). */
export function makeSerializedSwitchEmitter(
  post: SwitchAgentDeps['postEvent'],
): SwitchAgentDeps['postEvent'] {
  let chain: Promise<unknown> = Promise.resolve();
  return (type, payload) => {
    chain = chain.then(() => post(type, payload)).catch(() => undefined);
    return chain;
  };
}

export async function performAgentSwitch(
  deps: SwitchAgentDeps,
  rawAgentId: unknown,
): Promise<SwitchAgentResult> {
  const from = deps.currentAgent();
  const target = resolveSwitchTarget(rawAgentId, from);
  if (!target.ok) {
    return { ok: false, agentId: typeof rawAgentId === 'string' ? rawAgentId : '', error: target.error };
  }
  const agentId = target.agentId;
  const emitStatus = (status: SwitchAgentStatus): Promise<unknown> =>
    deps.postEvent('switch_agent_status', { ...status });
  const emitStep = (step: SwitchAgentStep): Promise<unknown> =>
    deps.postEvent('switch_agent_progress', { step, agentId });
  const fail = (error: string): SwitchAgentResult => {
    // ALWAYS leave a local log line — the 2026-08-13 fleet-1 kimi failure
    // was only diagnosable from the wire because the fail path logged
    // nothing on the box.
    log.warn('switchAgent', `switch ${from} → ${agentId} failed: ${error}`);
    void emitStatus({ state: 'error', agentId, fromAgentId: from, error });
    return { ok: false, agentId, error };
  };

  log.info('switchAgent', `switch requested ${from} → ${agentId}`);
  void emitStatus({ state: 'switching', agentId, fromAgentId: from });

  // 1. Credential — must already be vaulted (mobile only offers linked agents).
  void emitStep('credential');
  const cred = await deps.fetchCredential(agentId);
  if (!cred) {
    return fail(
      `No linked credential for ${displayName(agentId)}. Link it in Profile › Agents first.`,
    );
  }
  try {
    deps.provisionCredential(agentId, toAgentAuth(cred.method, cred.credential));
  } catch (err) {
    log.warn('switchAgent', `credential provisioning failed: ${(err as Error).message}`);
    return fail(`Couldn't write the ${displayName(agentId)} credential on this machine.`);
  }

  // 2. Binary — instant on baked images; installs on bare boxes.
  void emitStep('install');
  const bin = await deps.ensureBinary(agentId, cred.installScript);
  if (!bin.ok) return fail(bin.error);

  // 3. Restart on the new adapter. The old client is only stopped inside
  // swapRuntime, so every failure BEFORE this point leaves the session
  // untouched on the old agent.
  void emitStep('restart');
  try {
    await deps.swapRuntime(agentId);
  } catch (err) {
    log.warn('switchAgent', `swap failed, reverting to ${from}: ${(err as Error).message}`);
    try {
      await deps.revertRuntime(from);
    } catch (revertErr) {
      // Old agent didn't come back either — surfaceable but never silent:
      // the error status below tells the user the session needs a restart.
      log.warn('switchAgent', `revert failed: ${(revertErr as Error).message}`);
      return fail(
        `Switching to ${displayName(agentId)} failed and ${displayName(from)} couldn't be restored — restart the session.`,
      );
    }
    return fail(`Couldn't start ${displayName(agentId)} — the session stays on ${displayName(from)}.`);
  }

  // 4. Durability + visibility. Persist first (a crash between these still
  // resumes on the new agent — which IS the running one).
  try {
    deps.persistAgent(agentId);
  } catch (err) {
    log.warn('switchAgent', `persist failed (non-fatal): ${(err as Error).message}`);
  }
  deps.reannounce(agentId);
  await emitStatus({ state: 'ready', agentId, fromAgentId: from });
  log.info('switchAgent', `switch complete ${from} → ${agentId}`);
  return { ok: true, agentId };
}
