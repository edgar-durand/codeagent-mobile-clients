/**
 * Self-hosted host-agent — backend client + on-disk host-token seal.
 *
 * Design of record:
 * docs/superpowers/specs/2026-06-17-self-hosted-execution-plane-design.md
 *
 * Pure I/O boundary for the host-agent: redeem the ephemeral enroll
 * token for a long-lived host-token, seal it 0600 on the box, send
 * liveness heartbeats, and unseal the agent-auth blob the deploy command
 * forwards. Everything here is `fetch`-mockable so the supervisor logic
 * stays unit-testable.
 *
 * Trust model (matches the backend contract):
 *   - `redeem`    — NO host-token yet; the enroll token is the trust.
 *   - `heartbeat` — authenticated by `{ hostId, hostToken }` in the body
 *                   (the backend sha256-verifies against the stored hash).
 *   - `unseal`    — the host has no decryption key (the vault key is
 *                   HKDF-derived from SECRETS_ROOT_KEY, server-side only),
 *                   so the sealed agent-auth blob is exchanged for its
 *                   plaintext over an outbound, host-token-authenticated
 *                   call. See the Phase-3 note in host-agent.ts.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { resolveApiBaseUrl } from '@codeam/shared';
import type { AgentAuth } from '@codeam/shared';
import { vercelBypassHeader } from '../../lib/backend-headers';
import { restrictToOwner } from '../../lib/restrict-to-owner';

/** Diagnostics reported at redeem (mirrors the backend `HostOsInfo`). */
export interface HostOsInfo {
  distro?: string;
  arch?: string;
  kernel?: string;
  nodeVersion?: string;
}

/**
 * Live system metrics carried on the heartbeat so the app's "My Servers"
 * cards can show real CPU/RAM/latency. EXACT shape the backend accepts
 * (treated as optional there — older agents omit it).
 */
export interface HostMetrics {
  /** Real CPU utilization 0–100 (integer), from os.cpus() time deltas. */
  cpuPct: number;
  /** Used RAM in MiB. */
  ramUsedMb: number;
  /** Total RAM in MiB. */
  ramTotalMb: number;
  /** Measured heartbeat round-trip latency in ms (integer). */
  latencyMs: number;
}

/** A snapshot of aggregate CPU times across all cores. */
interface CpuTimesSnapshot {
  idle: number;
  total: number;
}

/** Sum idle + total CPU ticks across every core (one snapshot in time). */
function sampleCpuTimes(): CpuTimesSnapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/**
 * Best-effort live-metrics collector for the heartbeat.
 *
 * - cpuPct: computed HONESTLY from the delta of idle-vs-total CPU ticks
 *   (os.cpus()) between successive beats — i.e. the busy fraction over the
 *   heartbeat interval, not a point-in-time guess and not a fake constant.
 *   The very first beat has no prior sample, so it falls back to a
 *   loadavg-based proxy (clamped 0–100) for that single beat.
 * - ramUsedMb / ramTotalMb: straight from os.totalmem()/os.freemem().
 * - latencyMs: the round-trip of the PREVIOUS heartbeat (measured by the
 *   caller and fed back in via recordLatency); the first beat reports 0
 *   until a real measurement exists.
 *
 * Stateful across beats by design (CPU delta + latency carry-over). All
 * methods are pure-ish and never throw on their own.
 */
export class MetricsCollector {
  private prevCpu: CpuTimesSnapshot | null = null;
  private lastLatencyMs = 0;

  /** Record the measured round-trip of the heartbeat just sent. */
  recordLatency(latencyMs: number): void {
    this.lastLatencyMs = Math.max(0, Math.round(latencyMs));
  }

  private cpuPct(): number {
    const current = sampleCpuTimes();
    const prev = this.prevCpu;
    this.prevCpu = current;
    if (!prev) {
      // First beat: no interval to diff yet — use a loadavg proxy.
      const cores = os.cpus().length || 1;
      const proxy = (os.loadavg()[0] / cores) * 100;
      return Math.min(100, Math.max(0, Math.round(proxy)));
    }
    const idleDelta = current.idle - prev.idle;
    const totalDelta = current.total - prev.total;
    if (totalDelta <= 0) return 0;
    const busy = (1 - idleDelta / totalDelta) * 100;
    return Math.min(100, Math.max(0, Math.round(busy)));
  }

  /** Collect the current metrics snapshot for this beat. */
  collect(): HostMetrics {
    return {
      cpuPct: this.cpuPct(),
      ramUsedMb: Math.round((os.totalmem() - os.freemem()) / 1048576),
      ramTotalMb: Math.round(os.totalmem() / 1048576),
      latencyMs: this.lastLatencyMs,
    };
  }
}

/** The sealed identity the host-agent persists 0600 on the box. */
export interface SealedHostIdentity {
  hostId: string;
  /** Plaintext long-lived host-token (returned once at redeem). */
  hostToken: string;
  /** The relay pluginId the host-agent subscribes to for commands. */
  controlPluginId: string;
  /**
   * Raw proof-of-possession poll secret for the CONTROL plugin.
   *
   * Generated locally at redeem; its SHA-256 hash is enrolled on the backend
   * (redeem body `pluginSecretHash`) so the control channel is command-ready
   * the moment the host exists — a `self_hosted_deploy` can no longer race
   * ahead of enrollment (the PLUGIN_SECRET_REQUIRED ack 401). Replayed verbatim
   * as the `X-Plugin-Poll-Secret` header on the control channel's
   * `/api/commands/pending` + `/api/commands/ack` requests (the relay's
   * `pollSecretHeader`).
   *
   * OPTIONAL for backward-compat: an identity sealed by an OLDER CLI enrolled
   * no secret (and no hash) — see the reconnect note in host-agent.ts. Undefined
   * there → the control channel sends no header, exactly as before.
   */
  controlPollSecret?: string;
}

/** Shape of `POST /api/self-hosted/redeem`'s `data`. */
interface RedeemResponseData {
  hostId: string;
  hostToken: string;
  controlPluginId: string;
}

function apiBase(): string {
  return process.env.CODEAM_API_URL ?? resolveApiBaseUrl();
}

/** Path of the sealed host identity file: `~/.codeam/host-agent.json`. */
export function hostIdentityPath(): string {
  return path.join(os.homedir(), '.codeam', 'host-agent.json');
}

/** Collect best-effort OS diagnostics for the redeem call. */
export function collectOsInfo(): HostOsInfo {
  return {
    distro: os.platform(),
    arch: os.arch(),
    kernel: os.release(),
    nodeVersion: process.versions.node,
  };
}

/**
 * Read the sealed host identity if present + well-formed. Returns null
 * when the file is absent (first run) or unreadable/corrupt (re-redeem).
 */
export function loadHostIdentity(): SealedHostIdentity | null {
  try {
    const raw = fs.readFileSync(hostIdentityPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).hostId === 'string' &&
      typeof (parsed as Record<string, unknown>).hostToken === 'string' &&
      typeof (parsed as Record<string, unknown>).controlPluginId === 'string'
    ) {
      const p = parsed as Record<string, unknown>;
      return {
        hostId: p.hostId as string,
        hostToken: p.hostToken as string,
        controlPluginId: p.controlPluginId as string,
        // Optional — absent on identities sealed by a pre-secret CLI.
        ...(typeof p.controlPollSecret === 'string'
          ? { controlPollSecret: p.controlPollSecret }
          : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Seal the host identity to `~/.codeam/host-agent.json` owner-only
 *  (0600 on POSIX, icacls ACL on Windows — a bare chmod is an ACL no-op
 *  there). */
export function saveHostIdentity(identity: SealedHostIdentity): void {
  const file = hostIdentityPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(identity, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  restrictToOwner(file);
}

/** Machine-readable error codes the backend returns for terminal enroll failures. */
const TERMINAL_ENROLL_CODES = new Set(['ENROLL_TOKEN_EXPIRED', 'ENROLL_TOKEN_INVALID'] as const);

/**
 * A backend rejection that carries the HTTP status, so callers can tell a
 * genuine auth-rejection (the host was deleted / its token revoked) apart
 * from a transient network error. Only 401/403/404 mean "this identity is
 * dead, stop using it" — everything else (5xx, network blips) is transient
 * and must keep retrying.
 */
export class HostHttpError extends Error {
  constructor(
    message: string,
    /** The HTTP status the backend returned (0 for a non-HTTP failure). */
    readonly status: number,
    /**
     * The machine-readable error code from the backend response body
     * (e.g. `ENROLL_TOKEN_EXPIRED`, `ENROLL_TOKEN_INVALID`). Present only
     * when the backend returned a structured `{ error: { code } }` body.
     */
    readonly code?: string,
  ) {
    super(message);
    this.name = 'HostHttpError';
  }

  /**
   * True iff this is a genuine auth-rejection of the host identity:
   * 401 (token invalid), 403 (forbidden), 404 (host not found / deleted).
   * Transient failures (5xx, timeouts, network errors) are NOT rejections.
   */
  get isAuthRejection(): boolean {
    return this.status === 401 || this.status === 403 || this.status === 404;
  }

  /**
   * True iff the enroll token is permanently unusable: the backend returned
   * a terminal 4xx (410 Gone for expired/replayed, 400 Bad Request for
   * malformed/invalid) with a stable `ENROLL_TOKEN_*` error code.
   *
   * These failures must NOT be retried — the token will never become valid
   * again. The host-agent must surface a clear message and exit so the user
   * knows to generate a new token in the app.
   */
  get isTerminalEnrollError(): boolean {
    return typeof this.code === 'string' && TERMINAL_ENROLL_CODES.has(this.code as never);
  }
}

/**
 * Classify an unknown error thrown while talking to the backend as a
 * genuine host-identity auth-rejection (host deleted / token revoked).
 * Transient errors (network down, 5xx, abort) return false so the agent
 * keeps retrying rather than wiping a still-valid identity.
 */
export function isHostAuthRejection(err: unknown): boolean {
  return err instanceof HostHttpError && err.isAuthRejection;
}

/**
 * True iff the error is a terminal enroll-token failure — the token is
 * permanently unusable (expired, replayed, or structurally invalid). The
 * host-agent must NOT retry on these; it must surface a clear message and
 * stop so the user generates a fresh token in the app.
 */
export function isTerminalEnrollError(err: unknown): boolean {
  return err instanceof HostHttpError && err.isTerminalEnrollError;
}

/**
 * Remove the sealed host identity (`~/.codeam/host-agent.json`). Used by
 * the self-heal path when the backend rejects the host-token (host deleted
 * server-side) and by the `self_hosted_wipe` control command. Best-effort:
 * a missing file is fine, any other error is swallowed (the caller is about
 * to exit anyway and systemd will not re-seal a stale identity).
 */
export function deleteHostIdentity(): void {
  try {
    fs.rmSync(hostIdentityPath(), { force: true });
  } catch {
    /* best-effort — already gone or unwritable */
  }
}

async function postJson<T>(pathname: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${apiBase()}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...vercelBypassHeader() },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as
    | { success: true; data: T }
    | { success: false; error?: { code?: string; message?: string } };
  if (!res.ok || !json.success) {
    const errBody = !json.success ? json.error : undefined;
    throw new HostHttpError(
      `${pathname} failed (${errBody?.code ?? `HTTP_${res.status}`}): ${errBody?.message ?? res.statusText}`,
      res.status,
      errBody?.code,
    );
  }
  return json.data;
}

/**
 * Resolve the host label sent at redeem. Precedence:
 *   1. an explicit `label` arg (rare — a caller that already knows a name),
 *   2. `CODEAM_HOST_LABEL` env — set by whoever provisions a co-located
 *      host-agent so multiple instances on ONE box are distinguishable
 *      (the fleet host, a per-user 24/7 unit, a fleet box → "CodeAgent Box"),
 *   3. `os.hostname()` — the natural default for a BYO machine.
 * Without this, every enroll fell back to the backend's generic "my-server"
 * and a user's servers were indistinguishable. Bounded to 80 chars (the
 * backend's own cap) so the two sides never disagree.
 */
export function resolveHostLabel(label?: string): string {
  const explicit = label?.trim();
  const envLabel = process.env.CODEAM_HOST_LABEL?.trim();
  const resolved = explicit || envLabel || os.hostname();
  return resolved.slice(0, 80);
}

/**
 * Redeem the ephemeral enroll token for the long-lived host identity.
 * Idempotent at the call site (the caller only redeems when no sealed
 * identity exists); the enroll token itself is single-use server-side.
 */
export async function redeemEnrollToken(
  token: string,
  label?: string,
): Promise<SealedHostIdentity> {
  // Proof-of-possession secret for the CONTROL plugin. Same generation +
  // hashing as the interactive pair flow (pair.ts / pair-auto.ts) so the scheme
  // matches the backend verifier byte-for-byte: a random 32-byte secret,
  // replayed raw as `X-Plugin-Poll-Secret`, whose SHA-256 hex is enrolled as
  // `pluginSecretHash`. Enrolling it here makes the control channel
  // command-ready the instant the host exists — a pushed `self_hosted_deploy`
  // can no longer beat the host to poll-secret enrollment (the ack 401 bug).
  const controlPollSecret = randomBytes(32).toString('base64url');
  const pluginSecretHash = createHash('sha256').update(controlPollSecret).digest('hex');
  const data = await postJson<RedeemResponseData>('/api/self-hosted/redeem', {
    token,
    label: resolveHostLabel(label),
    osInfo: collectOsInfo(),
    // OPTIONAL + backward-compatible: older backends ignore the unknown field
    // and keep the pre-existing (no-secret) control-channel behavior.
    pluginSecretHash,
  });
  return {
    hostId: data.hostId,
    hostToken: data.hostToken,
    controlPluginId: data.controlPluginId,
    controlPollSecret,
  };
}

/**
 * One active supervised session on the heartbeat body, so the backend can
 * show the box's live sessions on the My Servers screen. `id` is the real
 * sessionId the backend recognizes; `agent`/`startedAt` are best-effort.
 * Additive contract — older backends ignore unknown fields.
 */
export interface HostSession {
  id: string;
  agent?: string;
  startedAt?: number;
}

/**
 * Send a liveness heartbeat (state liveness, NOT command polling).
 *
 * Carries ONLY liveness + optional live system metrics (additive; the
 * backend treats `metrics` as optional). Session state is deliberately NOT
 * sent here — re-sending a discrete state on every beat is polling. Sessions
 * flow over `reportSessionEvent` (discrete transitions) + the backend-owned
 * START in the pairing redemption path. Returns the measured round-trip
 * latency of THIS request in ms, so the caller can feed it back as the
 * `latencyMs` of the next beat (the only way to send a real, measured value).
 */
export async function sendHostHeartbeat(
  identity: SealedHostIdentity,
  metrics?: HostMetrics,
): Promise<number> {
  const start = process.hrtime.bigint();
  await postJson<{ ok: boolean }>('/api/self-hosted/heartbeat', {
    hostId: identity.hostId,
    hostToken: identity.hostToken,
    ...(metrics ? { metrics } : {}),
  });
  const elapsedNs = process.hrtime.bigint() - start;
  return Math.round(Number(elapsedNs) / 1_000_000);
}

/**
 * Report a discrete supervised-session lifecycle transition (NOT a poll).
 * Fired one-shot by the host-agent on a real process transition:
 *   - `ended`     — a session child exited (pass its `deployId`).
 *   - `reconcile` — supervisor boot (pass `activeDeployIds`, the live set);
 *                   the backend ends every row not listed, clearing zombies
 *                   left by a hard crash / reboot where no `ended` fired.
 * Best-effort: a failure (offline, transient) is swallowed by the caller —
 * the next `reconcile` on the following boot re-converges the set.
 */
export async function reportSessionEvent(
  identity: Pick<SealedHostIdentity, 'hostId' | 'hostToken'>,
  body:
    | { event: 'ended'; deployId: string }
    | { event: 'reconcile'; activeDeployIds: string[] },
): Promise<void> {
  await postJson<{ ok: boolean }>('/api/self-hosted/session-event', {
    hostId: identity.hostId,
    hostToken: identity.hostToken,
    ...body,
  });
}

/** A `SealedSecret` vault envelope (the deploy command's JSON blob). */
interface SealedEnvelope {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

function isSealedEnvelope(v: unknown): v is SealedEnvelope {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.ciphertext === 'string' &&
    typeof o.iv === 'string' &&
    typeof o.authTag === 'string' &&
    typeof o.keyVersion === 'number'
  );
}

function isAgentAuth(v: unknown): v is AgentAuth {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    (o.kind === 'oauth_token' || o.kind === 'api_key') && typeof o.value === 'string'
  );
}

/**
 * Resolve the sealed agent-auth blob the deploy command carries into the
 * plaintext `AgentAuth`. The host has no decryption key (server-side
 * only), so this is an outbound, host-token-authenticated round-trip —
 * the same posture as heartbeat/redeem (no inbound surface, no key
 * custody on the box).
 *
 * NOTE: the backend endpoint this targets does not exist yet — it is the
 * one backend change Phase 3 needs to close the loop end-to-end. The
 * supervisor accepts an injected resolver so this seam is exercised in
 * tests today and swapped for the real endpoint when it lands.
 */
export async function unsealAgentAuth(
  identity: SealedHostIdentity,
  sealedAgentAuth: string,
): Promise<AgentAuth> {
  const envelope: unknown = JSON.parse(sealedAgentAuth);
  if (!isSealedEnvelope(envelope)) {
    throw new Error('sealedAgentAuth is not a valid vault envelope');
  }
  const data = await postJson<{ kind: string; value: string }>(
    '/api/self-hosted/unseal-agent-auth',
    {
      hostId: identity.hostId,
      hostToken: identity.hostToken,
      sealedAgentAuth,
    },
  );
  if (!isAgentAuth(data)) {
    throw new Error('unseal-agent-auth returned an unexpected shape');
  }
  return data;
}

/** A function that turns the sealed blob into plaintext `AgentAuth`. */
export type AgentAuthResolver = (
  identity: SealedHostIdentity,
  sealedAgentAuth: string,
) => Promise<AgentAuth>;

/**
 * How a progress report authenticates to the backend:
 *   - `{ enrollToken }`        — pre-redeem (no host identity yet).
 *   - `{ hostId, hostToken }`  — post-redeem (sealed identity).
 *
 * The backend resolves the host by whichever it receives.
 */
export type ProgressAuth =
  | { enrollToken: string }
  | { hostId: string; hostToken: string };

/** Best-effort progress POST budget — never block the connect/heartbeat path. */
const PROGRESS_TIMEOUT_MS = 3_000;

/**
 * Report an enrollment-progress milestone to the backend so the app can
 * show real, box-side telemetry during enrollment.
 *
 * STRICTLY best-effort: fire-and-forget with a short timeout, every error
 * (network, abort, non-200, bad JSON) is swallowed. The backend returns
 * 200 regardless and ALSO emits enrolled/connected from its own
 * redeem/heartbeat, so these reports are purely additive and idempotent —
 * a failure here must NEVER fail or stall the host-agent.
 */
export async function reportProgress(
  auth: ProgressAuth,
  step: string,
  message: string,
): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROGRESS_TIMEOUT_MS);
    timer.unref?.();
    try {
      await fetch(`${apiBase()}/api/self-hosted/enroll-progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...vercelBypassHeader() },
        body: JSON.stringify({ ...auth, step, message }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    /* best-effort telemetry — swallow all failures */
  }
}

/** How a deploy-progress report authenticates: the sealed host identity. */
export type DeployProgressAuth = { hostId: string; hostToken: string };

/**
 * Report a deploy-progress milestone to the backend so the app can show
 * real, box-side telemetry during a `self_hosted_deploy` — mirroring the
 * codespace deploy log. Steps flow as the deploy proceeds (`preparing`,
 * `cloning`, `spawning`, `agent_starting`) and `failed` on any error.
 *
 * The backend owns the terminal `paired` step (it correlates the auto-pair
 * token to a session), so the host-agent never reports it.
 *
 * STRICTLY best-effort, exactly like {@link reportProgress}: fire-and-forget
 * with a short timeout; every error (network, abort, non-200, bad JSON) is
 * swallowed. A failure here must NEVER fail or stall the deploy.
 */
export async function reportDeployProgress(
  auth: DeployProgressAuth,
  deployId: string,
  step: string,
  message: string,
  sessionId?: string,
): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROGRESS_TIMEOUT_MS);
    timer.unref?.();
    try {
      await fetch(`${apiBase()}/api/self-hosted/deploy-progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...vercelBypassHeader() },
        body: JSON.stringify({
          ...auth,
          deployId,
          step,
          message,
          ...(sessionId ? { sessionId } : {}),
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    /* best-effort telemetry — swallow all failures */
  }
}

/** What a session-chat error bubble needs to authenticate + address itself:
 *  the persisted session's pairing identity (see `SavedSession`). */
export type SessionBubbleAuth = {
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
};

/**
 * Post a VISIBLE error bubble into a session's chat via the legacy
 * chat-render pipeline (`POST /api/commands/output`, plugin-auth) — the same
 * feed the ACP runner's `failureBubble` uses, so mobile renders it as a
 * normal completed agent turn. Two chunks: `new_turn` (opens the turn) then
 * `text` with `done: true` (closes it), mirroring `AcpPublisher.publishOutput`
 * shapes.
 *
 * Exists for the SUPERVISOR-side failures no session child is alive to
 * report: when the post-restart auto-resume exhausts its retries
 * (`resumePersistedSession`), the relay/backend are reachable but the agent
 * child is dead — without this the HOST heartbeat stayed green while the
 * SESSION sat silently stale for hours (fleet-1, 2026-08-20).
 *
 * Best-effort with a short timeout, same contract as
 * {@link reportDeployProgress}: every failure is swallowed — an unreachable
 * backend must never take down the supervisor.
 */
export async function postSessionErrorBubble(
  auth: SessionBubbleAuth,
  message: string,
): Promise<void> {
  const chunks: Record<string, unknown>[] = [
    { type: 'new_turn', done: false },
    { type: 'text', content: message, done: true },
  ];
  for (const chunk of chunks) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROGRESS_TIMEOUT_MS);
      timer.unref?.();
      try {
        await fetch(`${apiBase()}/api/commands/output`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Plugin-Auth-Token': auth.pluginAuthToken,
            ...vercelBypassHeader(),
          },
          body: JSON.stringify({
            sessionId: auth.sessionId,
            pluginId: auth.pluginId,
            ...chunk,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      /* best-effort — swallow; the file log already carries the loud error */
    }
  }
}
