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
  HOUSE_AGENT_ID,
  HOUSE_AGENT_NAME,
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
  // White-label rule: the house agent is always "CodeAgent Cloud", never the
  // underlying runtime's name.
  if (id === HOUSE_AGENT_ID) return HOUSE_AGENT_NAME;
  return isKnownAgentId(id) ? (AGENT_REGISTRY[id]?.displayName ?? id) : id;
}

/**
 * The message shown when the credential step fails. Uses the BACKEND's own
 * message verbatim when it sent one (e.g. `409 {code:'CREDENTIAL_EXPIRED',
 * message:"The vaulted \"claude_code\" credential expired and could not be
 * refreshed — re-link the agent"}`) — that's what actually happened and
 * names the fix. Falls back to the generic "no linked credential" copy only
 * when the backend truly had nothing to say (404 / older backend / network),
 * which is the ONLY case that copy is accurate for.
 */
function credentialFailureMessage(
  agentId: string,
  failure: { code?: string; message?: string },
): string {
  if (failure.message) return failure.message;
  return `No linked credential for ${displayName(agentId)}. Link it in Profile › Agents first.`;
}

/**
 * Validate a raw `switch_agent` payload agent id. Returns the typed id or a
 * human-readable refusal. Exported for the mobile-side contract tests.
 */
export interface ResolvedSwitchTarget {
  ok: true;
  /** Internal runtime to launch (the house agent runs the claude adapter). */
  agentId: AgentId;
  /** Wire id used for the credential fetch AND every progress/status event —
   *  the public `house-codeagent-cloud` sentinel for the house agent, the
   *  internal runtime id for everything else. */
  wireId: string;
  /** True when the target is the managed house agent (CodeAgent Cloud). */
  house: boolean;
}

export function resolveSwitchTarget(
  raw: unknown,
  currentAgent: AgentId,
  /** True when the RUNNING agent is the house agent — its runtime id is
   *  `claude`, so `currentAgent` alone can never tell house from real Claude. */
  currentIsHouse = false,
): ResolvedSwitchTarget | { ok: false; error: string } {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, error: 'switch_agent: missing agentId' };
  }
  // House agent (CodeAgent Cloud): runtime is the claude ACP adapter pointed
  // at our managed proxy. The credential step provisions the proxy env, not a
  // vaulted user credential.
  if (raw === HOUSE_AGENT_ID) {
    if (currentIsHouse) {
      return { ok: false, error: `${HOUSE_AGENT_NAME} is already this session's agent.` };
    }
    return { ok: true, agentId: 'claude', wireId: HOUSE_AGENT_ID, house: true };
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
  // On a HOUSE session `currentAgent` reads `claude`, but the running agent is
  // CodeAgent Cloud — switching to REAL Claude Code is a legitimate change.
  if (raw === currentAgent && !currentIsHouse) {
    return { ok: false, error: `${displayName(raw)} is already this session's agent.` };
  }
  return { ok: true, agentId: raw, wireId: raw, house: false };
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
    /**
     * Called once, immediately before the RETRY install attempt, so the
     * orchestrator can re-emit a progress step and mobile stops looking
     * frozen. See the watchdog note at the retry site.
     */
    onRetry?: () => void;
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
  // 300s (vs the 180s default) — the fleet-1 2026-08-14 incident showed a
  // slow self-hosted box interrupting npm mid install under the shorter cap.
  const res = await runInstall(installScript, { logScope: 'switchAgent', timeoutMs: 300_000 });
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

  // RETRY-ONCE (fleet-1, 2026-08-14): a codex switch on a self-hosted box
  // failed with "installed but its binary never appeared on PATH" — the box
  // showed npm's atomic bin-link left HALF-FINISHED
  // (`~/.local/bin/.codex-ykcFwAyA -> ../lib/node_modules/@openai/codex/bin/codex.js`
  // existed but the rename to `codex` never happened, likely the previous
  // 180s cap interrupting a slow install). Re-running the SAME install
  // script is safe (backend install snippets are idempotent) and completes
  // the half-finished link. Only fail with the honest message if a second
  // attempt also can't produce a visible binary.
  log.info(
    'switchAgent',
    'install probe failed — retrying install once (half-finished bin link class)',
  );
  // Re-emit the progress step so the retry is VISIBLE. Without it the switch
  // looks frozen for the entire second attempt.
  //
  // ⚠️ Re-emits the EXISTING `install` step on purpose. The backend DTO
  // accepts only `credential | install | restart`; inventing a `retry` step
  // would 400 the whole progress POST and lose the signal entirely.
  //
  // ⚠️ Watchdog interplay — worst case this whole call is 2 × 300 s install
  // plus 2 × 30 s probe (~11 min), which OVERRUNS mobile's 240 s switch
  // watchdog. That is accepted, not a bug: the watchdog fires an honest,
  // transient error in the UI, and the eventual `switch_agent_status: ready`
  // overwrites/heals the slot when the install finally lands (v2.63 store
  // semantics — status is last-write-wins per session, not append-only). The
  // re-emitted step also refreshes the client's activity signal in the
  // meantime.
  deps.onRetry?.();
  const retryRes = await runInstall(installScript, {
    logScope: 'switchAgent',
    timeoutMs: 300_000,
  });
  if (!retryRes.ok) {
    return {
      ok: false,
      error: retryRes.timedOut
        ? `${displayName(agentId)} install timed out.`
        : `${displayName(agentId)} install failed.`,
    };
  }
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
/**
 * Result of a vaulted-credential fetch — mirrors
 * `pairing.service.ts`'s `ProvisionCredentialResult` structurally (no
 * import: keeps this module's public contract self-contained and
 * test-friendly). `ok: false` carries the backend's OWN error code/message
 * when it had one (e.g. `409 {code:'CREDENTIAL_EXPIRED', message:'…'}`) so
 * the switch step can surface it verbatim instead of a misleading generic
 * "no linked credential" — see `performAgentSwitch`.
 */
export type CredentialFetchResult =
  | {
      ok: true;
      method: 'api_key' | 'oauth' | 'house_proxy';
      credential: string;
      /** Present for `house_proxy`: the managed agent-proxy origin the claude
       *  runtime is pointed at (`ANTHROPIC_BASE_URL`). */
      baseUrl?: string;
      installScript?: string;
    }
  | { ok: false; code?: string; message?: string };

export interface SwitchAgentDeps {
  currentAgent(): AgentId;
  /** True when the RUNNING agent is the house agent (CodeAgent Cloud) — its
   *  runtime id is `claude`, so `currentAgent()` alone can never tell. */
  currentIsHouse(): boolean;
  /** Serialized event POST — callers get strict emit-order on the wire. */
  postEvent(
    type: 'switch_agent_progress' | 'switch_agent_status',
    payload: Record<string, unknown>,
  ): Promise<unknown>;
  /** `agentId` is the WIRE id — the internal runtime id for real agents, the
   *  public `house-codeagent-cloud` sentinel for the house agent. */
  fetchCredential(agentId: string): Promise<CredentialFetchResult>;
  /** Write the credential with the per-agent provisioner. Throws on failure. */
  provisionCredential(agentId: AgentId, auth: AgentAuth): void;
  /** House-agent switch: stage the managed-proxy env for the claude adapter
   *  spawn (ANTHROPIC_BASE_URL/AUTH_TOKEN + model pins + isolated config
   *  dir). Throws on failure. */
  provisionHouseProxy(cfg: { baseUrl: string; token: string }): void;
  ensureBinary(
    agentId: AgentId,
    installScript: string | undefined,
    /** Invoked before the retry install attempt so the orchestrator can
     *  re-emit the `install` progress step (see `ensureAgentBinaryForSwitch`). */
    onRetry?: () => void,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * Stop the old client and bring the new agent fully up (cancel in-flight
   * turn → flush streaming → capture handoff → new adapter + client +
   * runtime/history rebuild → banner). Throws on failure — the orchestrator
   * then calls {@link revertRuntime}. `house` flags a house-agent (CodeAgent
   * Cloud) launch: the runtime spawns with the staged managed-proxy env and
   * the banner carries the white-label identity.
   */
  swapRuntime(agentId: AgentId, swapOpts: { house: boolean }): Promise<void>;
  /** Best-effort relaunch of the PRIOR agent after a failed swap. `house`
   *  restores the prior HOUSE state (a house session reverts to the proxy
   *  env, not to bare claude). */
  revertRuntime(agentId: AgentId, swapOpts: { house: boolean }): Promise<void>;
  /** Persist the new agent to ~/.codeam/config.json (session row). */
  persistAgent(agentId: AgentId): void;
  /** relay.setAgentMeta + reannounceAgents with the new agent. */
  reannounce(agentId: AgentId): void;
}

/**
 * Every lifecycle event type that shares the agent-switch POST endpoint —
 * the switch's own progress/status PLUS the Agent Squad handoff proposal
 * lifecycle. They ride ONE serialized chain (see
 * {@link makeSerializedSwitchEmitter}) so the backend republishes them in
 * strict emit order; a `handoff_resolved` can never overtake the
 * `switch_agent_status:ready` of the swap that resolved it.
 */
export type SquadEventType =
  'switch_agent_progress' | 'switch_agent_status' | 'handoff_proposed' | 'handoff_resolved';

export type SquadEventPoster = (
  type: SquadEventType,
  payload: Record<string, unknown>,
) => Promise<unknown>;

/** Build a serialized emitter over a raw poster (headroom emit-chain shape).
 *  Accepts the WIDE {@link SquadEventType} union so ONE chain serves both the
 *  switch events and the handoff events; the returned emitter is still
 *  assignable to the narrower {@link SwitchAgentDeps.postEvent}. */
export function makeSerializedSwitchEmitter(post: SquadEventPoster): SquadEventPoster {
  let chain: Promise<unknown> = Promise.resolve();
  return (type, payload) => {
    chain = chain.then(() => post(type, payload)).catch(() => undefined);
    return chain;
  };
}

/**
 * Fast-path knobs for a swap onto an agent this CLI process ALREADY brought
 * up once (Agent Squad @-mention routing bouncing between squad members).
 * Both default off, so every existing caller runs the full sequence.
 *
 * ⚠️ Skipping the credential step means a credential that EXPIRED since the
 * first provision surfaces as a swap failure instead — the caller must retry
 * ONCE on the full path before reporting failure (see `routeToAgent`).
 */
export interface AgentSwitchFastPath {
  /** Credential already written this process → skip fetch + provision. */
  skipProvision?: boolean;
  /** Launch binary already verified this process → skip the install probe. */
  skipInstall?: boolean;
}

export async function performAgentSwitch(
  deps: SwitchAgentDeps,
  rawAgentId: unknown,
  fastPath: AgentSwitchFastPath = {},
): Promise<SwitchAgentResult> {
  const from = deps.currentAgent();
  const fromIsHouse = deps.currentIsHouse();
  const target = resolveSwitchTarget(rawAgentId, from, fromIsHouse);
  if (!target.ok) {
    return {
      ok: false,
      agentId: typeof rawAgentId === 'string' ? rawAgentId : '',
      error: target.error,
    };
  }
  const agentId = target.agentId;
  // Every event carries the WIRE ids: the public house sentinel for the house
  // agent (mobile renders "CodeAgent Cloud"; the internal `claude` would break
  // the white-label rule), the internal runtime id for everything else.
  const wireId = target.wireId;
  const fromWireId = fromIsHouse ? HOUSE_AGENT_ID : from;
  const targetName = displayName(wireId);
  const emitStatus = (status: SwitchAgentStatus): Promise<unknown> =>
    deps.postEvent('switch_agent_status', { ...status });
  const emitStep = (step: SwitchAgentStep): Promise<unknown> =>
    deps.postEvent('switch_agent_progress', { step, agentId: wireId });
  const fail = (error: string): SwitchAgentResult => {
    // ALWAYS leave a local log line — the 2026-08-13 fleet-1 kimi failure
    // was only diagnosable from the wire because the fail path logged
    // nothing on the box.
    log.warn('switchAgent', `switch ${fromWireId} → ${wireId} failed: ${error}`);
    void emitStatus({ state: 'error', agentId: wireId, fromAgentId: fromWireId, error });
    return { ok: false, agentId: wireId, error };
  };

  log.info('switchAgent', `switch requested ${fromWireId} → ${wireId}`);
  void emitStatus({ state: 'switching', agentId: wireId, fromAgentId: fromWireId });

  // 1. Credential — must already be vaulted (mobile only offers linked agents;
  //    the house agent instead gets an ephemeral managed-proxy token minted by
  //    the backend). Skipped on the squad fast path (this process already
  //    wrote it): the step event is skipped too, so mobile's progress UI
  //    doesn't show a phantom stage the CLI never ran.
  let installScript: string | undefined;
  if (!fastPath.skipProvision) {
    void emitStep('credential');
    const cred = await deps.fetchCredential(wireId);
    if (!cred.ok) {
      return fail(credentialFailureMessage(wireId, cred));
    }
    if (target.house) {
      // The proxy env needs BOTH the token and the base URL — an older
      // backend answers this fetch with a 404 (no vaulted credential), never
      // a partial house payload, so this guard only trips on a malformed one.
      if (cred.method !== 'house_proxy' || !cred.baseUrl) {
        return fail(`${targetName} isn't available on this backend yet.`);
      }
      try {
        deps.provisionHouseProxy({ baseUrl: cred.baseUrl, token: cred.credential });
      } catch (err) {
        log.warn('switchAgent', `house proxy provisioning failed: ${(err as Error).message}`);
        return fail(`Couldn't configure ${targetName} on this machine.`);
      }
    } else {
      if (cred.method === 'house_proxy') {
        // Defensive: a house payload for a non-house target would write the
        // proxy token where a real credential belongs.
        return fail(`Couldn't fetch the ${targetName} credential.`);
      }
      try {
        deps.provisionCredential(agentId, toAgentAuth(cred.method, cred.credential));
      } catch (err) {
        log.warn('switchAgent', `credential provisioning failed: ${(err as Error).message}`);
        return fail(`Couldn't write the ${targetName} credential on this machine.`);
      }
    }
    installScript = cred.installScript;
  }

  // 2. Binary — instant on baked images; installs on bare boxes. Skipped when
  //    this process already resolved the binary for this agent.
  if (!fastPath.skipInstall) {
    void emitStep('install');
    // The retry re-emits `install` on the SAME serialized chain, so mobile
    // sees a second progress beat instead of ~5 more minutes of silence.
    const bin = await deps.ensureBinary(agentId, installScript, () => {
      void emitStep('install');
    });
    if (!bin.ok) return fail(bin.error);
  }

  // 3. Restart on the new adapter. The old client is only stopped inside
  // swapRuntime, so every failure BEFORE this point leaves the session
  // untouched on the old agent.
  void emitStep('restart');
  try {
    await deps.swapRuntime(agentId, { house: target.house });
  } catch (err) {
    log.warn('switchAgent', `swap failed, reverting to ${fromWireId}: ${(err as Error).message}`);
    try {
      await deps.revertRuntime(from, { house: fromIsHouse });
    } catch (revertErr) {
      // Old agent didn't come back either — surfaceable but never silent:
      // the error status below tells the user the session needs a restart.
      log.warn('switchAgent', `revert failed: ${(revertErr as Error).message}`);
      return fail(
        `Switching to ${targetName} failed and ${displayName(fromWireId)} couldn't be restored — restart the session.`,
      );
    }
    return fail(
      `Couldn't start ${targetName} — the session stays on ${displayName(fromWireId)}.`,
    );
  }

  // 4. Durability + visibility. Persist first (a crash between these still
  // resumes on the new agent — which IS the running one).
  try {
    deps.persistAgent(agentId);
  } catch (err) {
    log.warn('switchAgent', `persist failed (non-fatal): ${(err as Error).message}`);
  }
  deps.reannounce(agentId);
  await emitStatus({ state: 'ready', agentId: wireId, fromAgentId: fromWireId });
  log.info('switchAgent', `switch complete ${fromWireId} → ${wireId}`);
  return { ok: true, agentId: wireId };
}
