/**
 * `codeam host-agent` — self-hosted execution-plane supervisor.
 *
 * Design of record:
 * docs/superpowers/specs/2026-06-17-self-hosted-execution-plane-design.md
 *
 * Runs (under systemd) on the user's own Linux box. It is a thin
 * SUPERVISOR — it never touches the session layer:
 *
 *   1. Loads the sealed host identity (`~/.codeam/host-agent.json`), or
 *      redeems the `CODEAM_ENROLL_TOKEN` on first run and seals it.
 *   2. Opens ONE outbound control channel by REUSING the existing
 *      `CommandRelayService` (the same SSE-pull relay a normal session
 *      uses), subscribed on the host's `controlPluginId`. No new poll
 *      loop — control commands arrive over the relay; the only timer is
 *      a liveness heartbeat to `POST /api/self-hosted/heartbeat`.
 *   3. On `self_hosted_deploy`: prepares the workspace, writes the agent
 *      credential the SAME way a codespace does, and spawns
 *      `codeam pair-auto` as a supervised CHILD carrying
 *      `CODEAM_AUTO_TOKEN`. The child pairs back exactly like a codespace
 *      session — we add a supervisor, we do not reimplement pairing.
 *   4. On `self_hosted_stop { sessionId }`: kills the matching child.
 *
 * Reboot survival is systemd's job (it restarts this process); we re-open
 * the channel from the sealed token. Children are NOT auto-resumed (v1).
 *
 * ── Phase-3 / backend gap to close the loop ──────────────────────────
 * The deploy command's `sealedAgentAuth` is sealed with the backend's
 * vault key (HKDF from SECRETS_ROOT_KEY, server-side ONLY). The box holds
 * no decryption key — by design (no key custody). So turning the sealed
 * blob into a written credential requires an outbound,
 * host-token-authenticated `POST /api/self-hosted/unseal-agent-auth`
 * round-trip (see host-client.ts `unsealAgentAuth`). That endpoint is the
 * one backend change still needed to run the real Docker E2E (Phase 3).
 * Everything else here is complete + tested via an injected resolver.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { CommandRelayService, type RemoteCommand } from '../services/command-relay.service';
import type { AgentMetadata } from '@codeagent/shared';
import { log } from '../services/logger';
import {
  loadHostIdentity,
  redeemEnrollToken,
  saveHostIdentity,
  sendHostHeartbeat,
  unsealAgentAuth,
  type AgentAuthResolver,
  type SealedHostIdentity,
} from './host/host-client';
import { prepareWorkspace } from './host/workspace';
import { provisionAgentCredentials } from './host/agent-provisioning';

/** Liveness heartbeat cadence. State liveness only — NOT command polling. */
const HEARTBEAT_INTERVAL_MS = 20_000;

/** The deploy command payload (mirrors the backend `SelfHostedDeployCommand`). */
interface DeployPayload {
  deployId: string;
  repoOrPath: string;
  agentId: string;
  sealedAgentAuth: string;
  autoPairToken: string;
}

/** The stop command payload (mirrors the backend `SelfHostedStopCommand`). */
interface StopPayload {
  sessionId: string;
}

function isDeployPayload(p: Record<string, unknown>): p is DeployPayload & Record<string, unknown> {
  return (
    typeof p.deployId === 'string' &&
    typeof p.repoOrPath === 'string' &&
    typeof p.agentId === 'string' &&
    typeof p.sealedAgentAuth === 'string' &&
    typeof p.autoPairToken === 'string'
  );
}

function isStopPayload(p: Record<string, unknown>): p is StopPayload & Record<string, unknown> {
  return typeof p.sessionId === 'string';
}

/**
 * The control channel is a relay session, but it hosts NO agent — it is
 * a command pipe. Report it as a synthetic "control" agent so the relay's
 * required `AgentMetadata` is satisfied without mislabelling a real agent.
 */
const CONTROL_AGENT_META: AgentMetadata = {
  id: 'claude',
  displayName: 'CodeAgent Host Agent',
  binaryName: 'codeam',
  enabled: true,
  supportedAuthKinds: ['oauth_token'],
  preferredAuthKind: 'oauth_token',
};

/** A spawned `codeam pair-auto` child the supervisor manages. */
interface ChildSession {
  deployId: string;
  /** Resolved once the child reports its sessionId (see note in spawn). */
  sessionId: string;
  proc: ChildProcess;
}

/** How the supervisor spawns a child — injectable so tests don't fork. */
export type ChildSpawner = (env: Record<string, string>, cwd: string) => ChildProcess;

/** Default spawner: `codeam pair-auto` carrying CODEAM_AUTO_TOKEN. */
const defaultSpawner: ChildSpawner = (env, cwd) =>
  spawn(process.execPath, [process.argv[1], 'pair-auto'], {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'ignore',
    detached: false,
  });

/** Dependencies the supervisor needs — all injectable for tests. */
export interface HostAgentDeps {
  spawnChild?: ChildSpawner;
  resolveAgentAuth?: AgentAuthResolver;
  /** Factory for the relay (lets tests assert subscription without HTTP). */
  makeRelay?: (
    pluginId: string,
    onCommand: (cmd: RemoteCommand) => void | Promise<void>,
    meta: AgentMetadata,
  ) => Pick<CommandRelayService, 'start' | 'stop'>;
}

/**
 * The supervisor. Holds the control channel + the live children. Exposed
 * as a class so tests can drive `handleCommand` directly and assert child
 * tracking without standing up the real relay.
 */
export class HostAgentSupervisor {
  private readonly children = new Map<string, ChildSession>();
  private readonly spawnChild: ChildSpawner;
  private readonly resolveAgentAuth: AgentAuthResolver;
  private relay: Pick<CommandRelayService, 'start' | 'stop'> | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly identity: SealedHostIdentity,
    private readonly deps: HostAgentDeps = {},
  ) {
    this.spawnChild = deps.spawnChild ?? defaultSpawner;
    this.resolveAgentAuth = deps.resolveAgentAuth ?? unsealAgentAuth;
  }

  /** Open the control channel (reusing the relay) + start heartbeats. */
  start(): void {
    const make =
      this.deps.makeRelay ??
      ((pluginId, onCommand, meta) => new CommandRelayService(pluginId, onCommand, meta));
    // Reuse the existing SSE-pull relay as the control channel — exactly
    // like a normal session, but subscribed on the host's controlPluginId.
    this.relay = make(
      this.identity.controlPluginId,
      (cmd) => this.handleCommand(cmd),
      CONTROL_AGENT_META,
    );
    this.relay.start();

    // Liveness heartbeat (state, not command polling — the relay is the
    // command channel). Fire one immediately, then on the interval.
    void this.beat();
    this.heartbeatTimer = setInterval(() => void this.beat(), HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
    log.info('host-agent', `supervisor up host=${this.identity.hostId.slice(0, 8)}`);
  }

  /** Stop the control channel + heartbeats + kill every child. */
  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.relay?.stop();
    for (const child of this.children.values()) {
      try {
        child.proc.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    this.children.clear();
  }

  private async beat(): Promise<void> {
    try {
      await sendHostHeartbeat(this.identity);
    } catch (err) {
      log.trace('host-agent', 'heartbeat failed', err);
    }
  }

  /** Number of live children — for tests + diagnostics. */
  childCount(): number {
    return this.children.size;
  }

  /**
   * Route a relay command. Only `self_hosted_deploy` / `self_hosted_stop`
   * are understood; anything else is ignored (the box accepts no
   * arbitrary command surface).
   */
  async handleCommand(cmd: RemoteCommand): Promise<void> {
    if (cmd.type === 'self_hosted_deploy') {
      if (!isDeployPayload(cmd.payload)) {
        log.warn('host-agent', `ignoring malformed self_hosted_deploy id=${cmd.id}`);
        return;
      }
      await this.deploy(cmd.payload);
      return;
    }
    if (cmd.type === 'self_hosted_stop') {
      if (!isStopPayload(cmd.payload)) {
        log.warn('host-agent', `ignoring malformed self_hosted_stop id=${cmd.id}`);
        return;
      }
      this.stopChild(cmd.payload.sessionId);
      return;
    }
    log.trace('host-agent', `ignoring unsupported command type=${cmd.type}`);
  }

  /**
   * Prepare the workspace, write the agent credential (same as codespace
   * provisioning), and spawn a supervised `codeam pair-auto` child.
   *
   * The child claims its session via `CODEAM_AUTO_TOKEN`; the backend's
   * claim response is what binds the sessionId on the server side. We key
   * the child by `deployId` immediately (and adopt the sessionId — which
   * for self-hosted equals the deployId-correlated session) so a
   * subsequent `self_hosted_stop` can find it.
   */
  private async deploy(payload: DeployPayload): Promise<void> {
    log.info(
      'host-agent',
      `deploy id=${payload.deployId.slice(0, 8)} agent=${payload.agentId} target=${payload.repoOrPath}`,
    );
    const cwd = await prepareWorkspace(payload.repoOrPath, payload.deployId);

    // Resolve the sealed agent-auth → plaintext (outbound, host-token
    // authed) and write the credential files the agent reads at startup,
    // BEFORE spawning the child — matching the codespace ordering.
    const auth = await this.resolveAgentAuth(this.identity, payload.sealedAgentAuth);
    const credEnv = provisionAgentCredentials(payload.agentId, auth, undefined);

    const childEnv: Record<string, string> = {
      ...credEnv,
      CODEAM_AUTO_TOKEN: payload.autoPairToken,
    };
    const proc = this.spawnChild(childEnv, cwd);
    // Track by deployId now; the stop command uses sessionId, which the
    // backend correlates to this deploy (the control channel pushed the
    // stop with the session the child paired into). We index both ids so
    // stop matches whichever the backend sends.
    const child: ChildSession = { deployId: payload.deployId, sessionId: payload.deployId, proc };
    this.children.set(payload.deployId, child);

    proc.once('exit', () => {
      // Self-heal the map when a child dies on its own.
      if (this.children.get(payload.deployId)?.proc === proc) {
        this.children.delete(payload.deployId);
      }
    });
  }

  /** Kill the child matching `sessionId` (or its deployId). No-op if absent. */
  private stopChild(sessionId: string): void {
    const child = this.children.get(sessionId) ?? this.findBySessionId(sessionId);
    if (!child) {
      log.trace('host-agent', `stop: no child for sessionId=${sessionId}`);
      return;
    }
    log.info('host-agent', `stopping child deploy=${child.deployId.slice(0, 8)}`);
    try {
      child.proc.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    this.children.delete(child.deployId);
  }

  private findBySessionId(sessionId: string): ChildSession | undefined {
    for (const child of this.children.values()) {
      if (child.sessionId === sessionId) return child;
    }
    return undefined;
  }
}

/**
 * Resolve the sealed host identity: load it from disk, or redeem the
 * enroll token on first run + seal it. Returns null when neither is
 * available (no identity + no token → can't start).
 */
export async function resolveHostIdentity(
  enrollToken: string | undefined,
): Promise<SealedHostIdentity | null> {
  const existing = loadHostIdentity();
  if (existing) return existing;
  if (!enrollToken) return null;
  const identity = await redeemEnrollToken(enrollToken);
  saveHostIdentity(identity);
  return identity;
}

/**
 * Entry point for `codeam host-agent`. Reads the enroll token from
 * `CODEAM_ENROLL_TOKEN` (set by the systemd unit on first boot) or
 * `--token=…`, resolves the identity, and runs the supervisor.
 */
export async function hostAgent(args: string[] = []): Promise<void> {
  const tokenArg = args.find((a) => a.startsWith('--token='));
  const enrollToken =
    (tokenArg ? tokenArg.slice('--token='.length).trim() : '') ||
    process.env.CODEAM_ENROLL_TOKEN ||
    undefined;

  const identity = await resolveHostIdentity(enrollToken);
  if (!identity) {
    throw new Error(
      'host-agent: no sealed host identity and no enroll token. ' +
        'Re-run the installer from the app (tokens expire after 15 min).',
    );
  }

  const supervisor = new HostAgentSupervisor(identity);
  supervisor.start();

  // The supervisor runs until the process is killed (systemd). Keep the
  // event loop alive on the relay + heartbeat timer; tear down on signals.
  const shutdown = (): void => {
    supervisor.stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await new Promise<void>(() => {
    /* run forever — resolved only by process exit */
  });
}
