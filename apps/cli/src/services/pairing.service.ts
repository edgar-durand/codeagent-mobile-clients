import * as https from 'https';
import * as http from 'http';
import {
  resolveApiBaseUrl,
  type AgentReviewReport,
  type BeadsProvisioningPayload,
  type BeadsProvisioningStatus,
  type SquadRosterData,
} from '@codeam/shared';
import pkg from '../../package.json';
import { vercelBypassHeader } from '../lib/backend-headers';
import { detectCurrentBranch } from '../lib/git-branch';
import { resolveSessionHostname } from '../lib/session-hostname';
import { computePollDelay } from '../lib/poll-delay';
import type { SquadEventType } from '../agents/acp/switch-agent';

const API_BASE = resolveApiBaseUrl();

export interface PairedUserInfo {
  sessionId: string;
  /**
   * Backend user id (`user.id` from the pair response). Stable across
   * sessions / re-pairs. Used as the PostHog distinct id when telemetry
   * is on. Optional because older backends didn't emit it; identify
   * falls back to email in that case.
   */
  userId?: string;
  userName: string;
  userEmail: string;
  plan: string;
  /**
   * Per-pairing token returned by the backend (`/api/pairing/status` response
   * once `paired: true`). Replayed as `X-Plugin-Auth-Token` on subsequent
   * `/api/commands/output` POSTs so the server can authenticate the CLI
   * after the legacy fallback expires (2026-05-25). Undefined if the backend
   * is older than the rolling-token rollout.
   */
  pluginAuthToken?: string;
}

/**
 * Hard ceiling on how long the CLI is willing to wait for the backend
 * to ack `/api/pairing/code`. QA report #5: a transparent proxy was
 * accepting the TCP connection but never forwarding the body, leaving
 * the spinner on "Requesting pairing code..." for 10+ minutes. Anything
 * past ~10 s here is hostile UX — the user can `Ctrl-C + retry` in less
 * time than that. Resolves the outer call to `null` so `pair.ts` takes
 * the existing "Could not reach the server" path.
 */
const REQUEST_CODE_TIMEOUT_MS = 10_000;

/**
 * Discriminated result so callers can render the right message per
 * failure mode. The old `null` return treated every error path —
 * network down, 429, malformed body — as the same opaque "Could
 * not reach the server" string. A user being rate-limited needs a
 * countdown ("retry in 47s"), not a network troubleshooting hint.
 */
export type RequestCodeResult =
  | { ok: true; code: string; expiresAt: number }
  | { ok: false; reason: 'rate-limited'; retryAfterSeconds: number }
  | { ok: false; reason: 'timeout' }
  | { ok: false; reason: 'http'; status: number }
  | { ok: false; reason: 'network' };

export async function requestCode(
  pluginId: string,
  pluginSecretHash?: string,
): Promise<RequestCodeResult> {
  try {
    // Detect "running on a remote managed workspace" so the backend
    // (and apps) can show a "☁ codespace" tag next to the session,
    // distinguishing a `codeam deploy` from a regular local pair.
    // GitHub Codespaces sets CODESPACES=true and CODESPACE_NAME.
    const runtime = process.env.CODESPACES === 'true' ? 'github-codespaces' : 'local';
    const codespaceName = process.env.CODESPACE_NAME;
    // Detect the current git branch of the working directory so the
    // backend can populate `PairedSession.branch`. Re-detected on every
    // call so re-pairing in the same shell after a `git checkout` picks
    // up the new branch. Returns `null` on detached HEAD / non-git dirs.
    const branch = detectCurrentBranch();
    // Call through _transport so vi.spyOn can intercept in tests
    const post = _transport.postJson(`${API_BASE}/api/pairing/code`, {
      pluginId,
      ideName: 'Terminal (codeam-cli)',
      ideVersion: pkg.version,
      // In a codespace `os.hostname()` is the SAME shared `codespaces-<hash>`
      // for every user (wrapper-repo strategy) — report the user's repo instead.
      hostname: resolveSessionHostname(),
      runtime,
      branch,
      ...(codespaceName ? { codespaceName } : {}),
      // SEC: proof-of-possession enrollment. Backend carries this hash
      // onto the session and requires the raw secret on /status +
      // /reconnect. Older backends ignore the unknown field.
      ...(pluginSecretHash ? { pluginSecretHash } : {}),
    });
    // Race the request against a hard timeout. The underlying socket
    // is leaked when the timeout wins (no AbortController plumbed
    // through `_postJson`), but the OS / GC reaps it once the process
    // exits — acceptable since the user is already on the "give up
    // and retry" path.
    let timer: NodeJS.Timeout | undefined;
    const timeoutSentinel = Symbol('request-code-timeout');
    const timeoutPromise = new Promise<typeof timeoutSentinel>((resolve) => {
      timer = setTimeout(() => resolve(timeoutSentinel), REQUEST_CODE_TIMEOUT_MS);
    });
    const result = await Promise.race([post, timeoutPromise]);
    clearTimeout(timer);
    if (result === timeoutSentinel) return { ok: false, reason: 'timeout' };
    const data = result?.data as Record<string, unknown> | undefined;
    if (!data?.code) return { ok: false, reason: 'network' };
    return {
      ok: true,
      code: data.code as string,
      expiresAt: data.expiresAt as number,
    };
  } catch (err) {
    const e = err as Error & { statusCode?: number; retryAfterSeconds?: number };
    if (e.statusCode === 429) {
      return {
        ok: false,
        reason: 'rate-limited',
        retryAfterSeconds:
          typeof e.retryAfterSeconds === 'number' && e.retryAfterSeconds > 0
            ? e.retryAfterSeconds
            : 60,
      };
    }
    if (typeof e.statusCode === 'number') {
      return { ok: false, reason: 'http', status: e.statusCode };
    }
    return { ok: false, reason: 'network' };
  }
}

/**
 * Reconnect an existing pairing and pick up a fresh pluginAuthToken.
 *
 * `/api/pairing/reconnect` is unauthenticated (the trust is the
 * already-paired `(sessionId, pluginId)` tuple) and does THREE things
 * in one round-trip:
 *
 *   1. Mints a token signed by the backend's CURRENT JWT_SECRET, so
 *      we survive secret rotations / api-v1 → api-v2 cutovers that
 *      would otherwise leave the persisted token replaying as a 401
 *      INVALID_PLUGIN_TOKEN on every `/api/commands/output` POST.
 *   2. Flips `PairedSession.status` back to `ACTIVE` if it had drifted
 *      to `PAUSED` / `DISCONNECTED` (e.g. the user left codeam off
 *      overnight) so the mobile session card un-greys instead of
 *      staying on "Reconnect".
 *   3. Sets the Redis pluginStatus key to `online`, eliminating the
 *      30-second window where the dashboard would otherwise render
 *      OFFLINE between boot and the first heartbeat.
 *
 * Used by `start.ts` on every CLI boot for a resumed session. Returns
 * `null` on network failure or 404 — callers fall back to the
 * persisted token (steady state) rather than aborting.
 */
export async function fetchCurrentPluginAuthToken(
  sessionId: string,
  pluginId: string,
  pollSecret?: string,
): Promise<string | null> {
  try {
    const result = await _transport.postJson(
      `${API_BASE}/api/pairing/reconnect`,
      {
        sessionId,
        pluginId,
        // Send the running CLI version so the backend keeps
        // PairedSession.ideVersion current across restarts. This fixes the
        // stale "CLI update available" banner that showed an outdated version
        // after the CLI restarted on a new release and took the reconnect
        // path (which previously never updated ideVersion). Backends older
        // than the matching fix ignore the unknown field (backward-compat).
        ideVersion: pkg.version,
      },
      // SEC: prove possession so the gated /reconnect returns the token.
      // Omitted for legacy sessions (no secret) → backend legacy path.
      pollSecret ? { 'X-Plugin-Poll-Secret': pollSecret } : undefined,
    );
    const data = result?.data as Record<string, unknown> | undefined;
    if (!data?.paired) return null;
    const token = data.pluginAuthToken;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

// Exported transport object — allows tests to spy on individual methods without
// relying on CommonJS `exports` (which breaks in bundled output)
export const _transport = {
  postJson: _postJson,
  getJson: _getJson,
  postJsonAuthed: _postJsonAuthed,
};

/**
 * POST a credential blob to `/api/plugin/agents/:agentId/link` for
 * the `codeam link <agent>` CLI handoff flow.
 *
 * Auth is the per-pairing `X-Plugin-Auth-Token` minted at pair-time —
 * NOT a JWT. The backend's `PluginAuthGuard` verifies the HMAC against
 * the body's `sessionId+pluginId` (so we always send both).
 */
export async function postLinkCredential(input: {
  /**
   * Backend-facing publicId for the agent. Widened to `string` from
   * the original `'claude_code' | 'codex'` union in #56 so any agent
   * strategy can supply its own without editing this union. Validity
   * is enforced by the backend (404 on unknown agentId).
   */
  agentId: string;
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  method: 'oauth' | 'api_key' | 'setup_token';
  credential: string;
  modelPreference?: string;
  /**
   * Optional companion local-state blob (see LocalAgentToken
   * .agentState). Older backends silently ignore unknown body keys
   * via class-validator's `whitelist: true`, so this stays
   * backwards-compatible across the rollout window.
   */
  agentState?: string;
  /**
   * When `true`, the backend does NOT delete the PairedSession
   * after sealing the credential. Required when called from
   * `codeam pair` auto-link (the session is the user's real
   * pairing, not a throwaway). Older backends ignore the key.
   */
  preserveSession?: boolean;
}): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const body: Record<string, unknown> = {
    sessionId: input.sessionId,
    pluginId: input.pluginId,
    method: input.method,
    credential: input.credential,
  };
  if (input.modelPreference) {
    body.modelPreference = input.modelPreference;
  }
  if (input.agentState) {
    body.agentState = input.agentState;
  }
  if (input.preserveSession) {
    body.preserveSession = true;
  }
  try {
    await _transport.postJsonAuthed(
      `${API_BASE}/api/plugin/agents/${input.agentId}/link`,
      body,
      input.pluginAuthToken,
    );
    return { ok: true };
  } catch (err) {
    const e = err as Error & { statusCode?: number };
    return {
      ok: false,
      status: typeof e.statusCode === 'number' ? e.statusCode : 0,
      message: e.message || 'unknown',
    };
  }
}

/**
 * POST the CLI-side abort signal when `codeam link <agent>` refuses
 * to upload a stale credential snapshot (or hits a fatal upload
 * error). Hits `/api/plugin/agents/:agentId/link-error` so the
 * backend publishes `linked_agent_link_failed` on the user-events
 * bus — the LinkAgent flow on mobile / landing then flips from its
 * waiting spinner to an actionable error card instead of timing out
 * silently.
 *
 * Best-effort: any network / backend failure swallows; the CLI
 * still surfaces the error to the user via stderr and exits.
 */
export async function postLinkErrorSignal(input: {
  agentId: string;
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  code: string;
  reason: string;
}): Promise<void> {
  try {
    await _transport.postJsonAuthed(
      `${API_BASE}/api/plugin/agents/${input.agentId}/link-error`,
      {
        sessionId: input.sessionId,
        pluginId: input.pluginId,
        code: input.code,
        reason: input.reason,
      },
      input.pluginAuthToken,
    );
  } catch {
    /* best-effort — CLI surfaces the error locally regardless */
  }
}

/**
 * POST an AI summary / per-file insight back to the backend after
 * the agent's headless one-shot completed.
 *
 * The backend's `AiInsightsController` caches the result in Redis
 * and publishes `ai_summary_ready` / `ai_insight_ready` over the
 * existing per-user SSE bus so the web/mobile clients can flip from
 * the "Generating insights…" placeholder to the rendered text.
 */
export async function postAiResult(input: {
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  kind: 'summary' | 'insight';
  summary: string;
  /** Required when kind === 'summary'. */
  turnId?: string;
  stats?: { added: number; removed: number; complexityShift: number };
  /** Required when kind === 'insight'. */
  fileChangeId?: string;
  reasoning?: string;
  securityNote?: string;
}): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const body: Record<string, unknown> = {
    sessionId: input.sessionId,
    pluginId: input.pluginId,
    kind: input.kind,
    summary: input.summary,
  };
  if (input.turnId) body.turnId = input.turnId;
  if (input.stats) body.stats = input.stats;
  if (input.fileChangeId) body.fileChangeId = input.fileChangeId;
  if (input.reasoning) body.reasoning = input.reasoning;
  if (input.securityNote) body.securityNote = input.securityNote;
  try {
    await _transport.postJsonAuthed(
      `${API_BASE}/api/plugin/ai-result`,
      body,
      input.pluginAuthToken,
    );
    return { ok: true };
  } catch (err) {
    const e = err as Error & { statusCode?: number };
    return {
      ok: false,
      status: typeof e.statusCode === 'number' ? e.statusCode : 0,
      message: e.message || 'unknown',
    };
  }
}

/**
 * POST an in-app preview lifecycle event to the backend so mobile +
 * web SessionDetail's Preview surface reacts without polling. The
 * `PreviewController` re-publishes the event on the per-user SSE bus
 * and mirrors the derived state into Redis (1 h TTL) so reconnecting
 * dashboards re-derive without waiting for the next live event.
 *
 * Fire-and-forget: the caller logs failures but doesn't surface them
 * — preview UX degrades gracefully when the backend is unreachable
 * (the user's dev server + tunnel keep running, they just can't see
 * the state in the mobile / web client).
 */
export async function postPreviewEvent(input: {
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  type:
    | 'preview_detection_pending'
    | 'preview_detection_ready'
    | 'preview_starting'
    | 'preview_ready'
    | 'preview_stopped'
    | 'preview_error'
    | 'preview_progress';
  payload?: Record<string, unknown>;
}): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  try {
    await _transport.postJsonAuthed(
      `${API_BASE}/api/preview/events`,
      {
        sessionId: input.sessionId,
        pluginId: input.pluginId,
        type: input.type,
        payload: input.payload ?? {},
      },
      input.pluginAuthToken,
    );
    return { ok: true };
  } catch (err) {
    const e = err as Error & { statusCode?: number };
    return {
      ok: false,
      status: typeof e.statusCode === 'number' ? e.statusCode : 0,
      message: e.message || 'unknown',
    };
  }
}

/**
 * Push the serialized `.env` for a repo into the backend vault so a future
 * session of the SAME repo (fresh codespace / box / machine) can restore it.
 * Keyed by the stable `projectKey` (git-origin-derived, same as Beads). The
 * contents are sealed server-side; this call sends them over the authed channel
 * only. Fire-and-forget — a vault failure must never break the local `.env`
 * write. Mirrors `postPreviewEvent`.
 */
export async function pushProjectEnv(input: {
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  projectKey: string;
  projectLabel?: string;
  content: string;
  keyCount?: number;
}): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  try {
    await _transport.postJsonAuthed(
      `${API_BASE}/api/project-env/push`,
      {
        sessionId: input.sessionId,
        pluginId: input.pluginId,
        projectKey: input.projectKey,
        projectLabel: input.projectLabel,
        content: input.content,
        keyCount: input.keyCount,
      },
      input.pluginAuthToken,
    );
    return { ok: true };
  } catch (err) {
    const e = err as Error & { statusCode?: number };
    return {
      ok: false,
      status: typeof e.statusCode === 'number' ? e.statusCode : 0,
      message: e.message || 'unknown',
    };
  }
}

/**
 * Pull the stored `.env` for a repo from the backend vault. Returns the
 * serialized contents when the server has one for this (user, projectKey), or
 * `null` on a miss / any error (so the caller silently falls back to its normal
 * `.env` generation). Mirrors `postPreviewEvent`.
 */
export async function pullProjectEnv(input: {
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  projectKey: string;
}): Promise<{ content: string; keyCount: number } | null> {
  try {
    const res = await _transport.postJsonAuthed(
      `${API_BASE}/api/project-env/pull`,
      {
        sessionId: input.sessionId,
        pluginId: input.pluginId,
        projectKey: input.projectKey,
      },
      input.pluginAuthToken,
    );
    if (res && res.exists === true && typeof res.content === 'string') {
      const keyCount = typeof res.keyCount === 'number' ? res.keyCount : 0;
      return { content: res.content, keyCount };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Post a session-baton driver-state event to the backend so the mobile /
 * web SessionDetail can render "Take Control" / handoff state without
 * polling. Mirrors `postPreviewEvent` — fire-and-forget, non-fatal.
 */
export interface PostBatonEventArgs {
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  state: 'LOCAL_DRIVE' | 'MOBILE_DRIVE' | 'SWITCHING';
  driver: 'local_tui' | 'mobile_acp';
  conversationId: string | null;
}

export async function postBatonEvent(
  input: PostBatonEventArgs,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  try {
    await _transport.postJsonAuthed(
      `${API_BASE}/api/baton/events`,
      {
        sessionId: input.sessionId,
        pluginId: input.pluginId,
        state: input.state,
        driver: input.driver,
        conversationId: input.conversationId,
      },
      input.pluginAuthToken,
    );
    return { ok: true };
  } catch (err) {
    const e = err as Error & { statusCode?: number };
    return {
      ok: false,
      status: typeof e.statusCode === 'number' ? e.statusCode : 0,
      message: e.message || 'unknown',
    };
  }
}

/**
 * Post a Headroom lifecycle event (enable / disable / progress) to the backend.
 * Mirrors `postPreviewEvent` — fire-and-forget, non-fatal.
 */
export async function postHeadroomEvent(input: {
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  type: 'headroom_progress' | 'headroom_status';
  payload?: Record<string, unknown>;
}): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  try {
    await _transport.postJsonAuthed(
      `${API_BASE}/api/headroom/events`,
      {
        sessionId: input.sessionId,
        pluginId: input.pluginId,
        type: input.type,
        payload: input.payload ?? {},
      },
      input.pluginAuthToken,
    );
    return { ok: true };
  } catch (err) {
    const e = err as Error & { statusCode?: number };
    return {
      ok: false,
      status: typeof e.statusCode === 'number' ? e.statusCode : 0,
      message: e.message || 'unknown',
    };
  }
}

/**
 * Post a CodeRabbit reviewer lifecycle event (link progress / status / review
 * result) to the backend. Mirrors `postHeadroomEvent` — fire-and-forget,
 * non-fatal. The backend republishes on the per-user SSE bus so the mobile UI
 * can render the OAuth `authUrl`, link progress, and review findings live.
 */
/**
 * Parse a backend error body — best-effort. Returns null when the body is
 * absent/not JSON/carries neither field, so callers fall back to their own
 * generic copy.
 *
 * The REAL envelope (confirmed against api-v2's `AllExceptionsFilter`, which
 * serializes EVERY `DomainHttpException` — including `LinkedAgentsError` /
 * `CREDENTIAL_EXPIRED` — this way; see
 * `codeagent-mobile/apps/api-v2/src/common/filters/all-exceptions.filter.ts`
 * and the doc-comment atop `plugin-linked-agents.controller.ts`) is the
 * NESTED shape:
 *   `{ success: false, error: { code, message } }`
 * NOT a flat `{ code, message }` — that flat shape was an unverified
 * assumption in the original version of this function and meant the
 * `switch_agent` credential step NEVER actually surfaced the backend's
 * message (fleet-1 harness, 2026-08-15: a real daemon against a stub
 * returning the exact 409 body above still emitted the generic "No linked
 * credential" copy). Falls back to checking a flat `{code, message}` too, in
 * case an older/different endpoint ever used that shape.
 */
function parseBackendErrorBody(
  body: string | undefined,
): { code?: string; message?: string } | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as {
      code?: unknown;
      message?: unknown;
      error?: { code?: unknown; message?: unknown };
    };
    const nested = parsed.error;
    const code =
      typeof nested?.code === 'string'
        ? nested.code
        : typeof parsed.code === 'string'
          ? parsed.code
          : undefined;
    const message =
      typeof nested?.message === 'string'
        ? nested.message
        : typeof parsed.message === 'string'
          ? parsed.message
          : undefined;
    return code || message ? { code, message } : null;
  } catch {
    return null;
  }
}

export type ProvisionCredentialResult =
  | { ok: true; method: 'api_key' | 'oauth'; credential: string; installScript?: string }
  | { ok: false; status: number; code?: string; message?: string };

/**
 * Fetch the caller's ALREADY-vaulted credential for an agent so the CLI can
 * provision it onto a fresh session without a re-login. Returns a
 * DISCRIMINATED result so a caller that needs to tell "no vaulted
 * credential" (404 / older backend / malformed payload) apart from a REAL
 * backend error (e.g. `409 {code: 'CREDENTIAL_EXPIRED', message: '…'}`) can
 * surface the backend's own message instead of a misleading generic one —
 * the fix for the `switch_agent` credential step showing "No linked
 * credential" when the backend actually said the vaulted credential expired
 * (fleet-1, 2026-08-13/14). See {@link fetchProvisionCredential} for the
 * older null-on-any-failure contract kept for callers that only need a
 * yes/no.
 */
export async function fetchProvisionCredentialDetailed(input: {
  agentId: string;
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  /**
   * When true, ask the backend to also return the agent's idempotent
   * install snippet (`ProvisioningStrategy.getInstallSnippet()`), so the
   * in-session agent switch can install a missing binary. Older backends
   * ignore the flag and simply omit `installScript`.
   */
  includeInstallScript?: boolean;
}): Promise<ProvisionCredentialResult> {
  try {
    const res = await _transport.postJsonAuthed(
      `${API_BASE}/api/plugin/agents/${input.agentId}/provision-credential`,
      {
        sessionId: input.sessionId,
        pluginId: input.pluginId,
        ...(input.includeInstallScript ? { includeInstallScript: true } : {}),
      },
      input.pluginAuthToken,
    );
    const data = (
      res as { data?: { method?: unknown; credential?: unknown; installScript?: unknown } } | null
    )?.data;
    if (
      data &&
      (data.method === 'api_key' || data.method === 'oauth') &&
      typeof data.credential === 'string' &&
      data.credential.length > 0
    ) {
      return {
        ok: true,
        method: data.method,
        credential: data.credential,
        ...(typeof data.installScript === 'string' && data.installScript.length > 0
          ? { installScript: data.installScript }
          : {}),
      };
    }
    // 2xx but a missing/malformed payload — treat as "nothing vaulted",
    // same as a 404, with no backend code/message to surface.
    return { ok: false, status: 0 };
  } catch (err) {
    const e = err as Error & { statusCode?: number; body?: string };
    const status = typeof e.statusCode === 'number' ? e.statusCode : 0;
    const parsed = parseBackendErrorBody(e.body);
    return { ok: false, status, code: parsed?.code, message: parsed?.message };
  }
}

/**
 * Older null-on-any-failure contract over {@link fetchProvisionCredentialDetailed}
 * — 404 = no vaulted credential, older backend, network, or any other
 * failure all collapse to `null` so the caller cleanly falls back to the
 * normal link flow. Kept for callers (CodeRabbit mention / provision) that
 * only need a yes/no and don't render the failure as a chat message.
 */
export async function fetchProvisionCredential(
  input: Parameters<typeof fetchProvisionCredentialDetailed>[0],
): Promise<{ method: 'api_key' | 'oauth'; credential: string; installScript?: string } | null> {
  const res = await fetchProvisionCredentialDetailed(input);
  if (!res.ok) return null;
  return {
    method: res.method,
    credential: res.credential,
    ...(res.installScript ? { installScript: res.installScript } : {}),
  };
}

/**
 * Fetch the squad roster (linked agents + whether agent-proposed handoffs are
 * enabled) from `/api/plugin/agents/roster`. Mirrors `fetchProvisionCredential`'s
 * null-on-failure contract — non-2xx, thrown errors, and malformed payloads
 * (missing `agents` array) all resolve to `null` so callers on an older backend
 * or offline simply run without squad features.
 */
export async function fetchSquadRoster(input: {
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
}): Promise<SquadRosterData | null> {
  try {
    const res = await _transport.postJsonAuthed(
      `${API_BASE}/api/plugin/agents/roster`,
      { sessionId: input.sessionId, pluginId: input.pluginId },
      input.pluginAuthToken,
    );
    const data = (res as { data?: SquadRosterData } | null)?.data;
    if (!data || !Array.isArray(data.agents)) return null;
    return { agents: data.agents, handoffsEnabled: data.handoffsEnabled === true };
  } catch {
    return null; // old backend / offline → squad features silently off
  }
}

/**
 * Post an agent-switch lifecycle event (progress step / terminal status) to
 * the backend. Mirrors `postHeadroomEvent` — non-fatal; callers serialize the
 * POSTs (emit-chain) so the backend receives them strictly in emit order.
 *
 * `handoff_proposed` / `handoff_resolved` cover the Agent Squad agent-proposed
 * handoff lifecycle (PRO); they share this endpoint with the existing
 * switch_agent_* progress/status events.
 */
export async function postAgentSwitchEvent(input: {
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  type: SquadEventType;
  payload?: Record<string, unknown>;
}): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  try {
    await _transport.postJsonAuthed(
      `${API_BASE}/api/agent-switch/events`,
      {
        sessionId: input.sessionId,
        pluginId: input.pluginId,
        type: input.type,
        payload: input.payload ?? {},
      },
      input.pluginAuthToken,
    );
    return { ok: true };
  } catch (err) {
    const e = err as Error & { statusCode?: number };
    return {
      ok: false,
      status: typeof e.statusCode === 'number' ? e.statusCode : 0,
      message: e.message || 'unknown',
    };
  }
}

/**
 * POST the finished agent-review report to the backend so it can fire the
 * completion push + render the Completion Result card. Mirrors
 * `postCoderabbitEvent` — fire-and-forget, non-fatal. Only CodeRabbit (the
 * one non-ACP reviewer) posts this from the CLI; ACP agents leave the verdict
 * on GitHub via their own prompt and the backend derives the report itself.
 * Endpoint: `POST /api/vcs/agent-review/report` (X-Plugin-Auth-Token).
 */
export async function postAgentReviewReport(input: {
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  report: AgentReviewReport;
}): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  try {
    await _transport.postJsonAuthed(
      `${API_BASE}/api/vcs/agent-review/report`,
      {
        sessionId: input.sessionId,
        pluginId: input.pluginId,
        report: input.report,
      },
      input.pluginAuthToken,
    );
    return { ok: true };
  } catch (err) {
    const e = err as Error & { statusCode?: number };
    return {
      ok: false,
      status: typeof e.statusCode === 'number' ? e.statusCode : 0,
      message: e.message || 'unknown',
    };
  }
}

export async function postCoderabbitEvent(input: {
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  type: 'coderabbit_progress' | 'coderabbit_status' | 'coderabbit_review';
  payload?: Record<string, unknown>;
}): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  try {
    await _transport.postJsonAuthed(
      `${API_BASE}/api/coderabbit/events`,
      {
        sessionId: input.sessionId,
        pluginId: input.pluginId,
        type: input.type,
        payload: input.payload ?? {},
      },
      input.pluginAuthToken,
    );
    return { ok: true };
  } catch (err) {
    const e = err as Error & { statusCode?: number };
    return {
      ok: false,
      status: typeof e.statusCode === 'number' ? e.statusCode : 0,
      message: e.message || 'unknown',
    };
  }
}

/**
 * Post a Beads lifecycle event (enable / disable / status) to the backend.
 * Mirrors `postHeadroomEvent` — fire-and-forget, non-fatal. The backend
 * republishes these on the per-user SSE bus so the mobile UI can track
 * beads_configure progress in real time.
 */
export async function postBeadsEvent(input: {
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  type: 'beads_status';
  payload?: Record<string, unknown>;
}): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  try {
    await _transport.postJsonAuthed(
      `${API_BASE}/api/beads/events`,
      {
        sessionId: input.sessionId,
        pluginId: input.pluginId,
        type: input.type,
        payload: input.payload ?? {},
      },
      input.pluginAuthToken,
    );
    return { ok: true };
  } catch (err) {
    const e = err as Error & { statusCode?: number };
    return {
      ok: false,
      status: typeof e.statusCode === 'number' ? e.statusCode : 0,
      message: e.message || 'unknown',
    };
  }
}

/**
 * Post a CLI self-update progress event to the backend so the mobile UI can
 * track the update in real time. Mirrors `postHeadroomEvent` — fire-and-forget,
 * non-fatal. The backend republishes on the per-user SSE bus.
 *
 * Phases:
 *   - `updating`    — npm install started
 *   - `relaunching` — install succeeded, process re-launching
 *   - `failed`      — npm install failed (includes a short error string)
 */
export async function postCliUpdateEvent(input: {
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  phase: 'updating' | 'relaunching' | 'failed';
  error?: string;
}): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  try {
    const payload: Record<string, unknown> = { phase: input.phase };
    if (input.error) payload.error = input.error;
    await _transport.postJsonAuthed(
      `${API_BASE}/api/agents/cli-update/events`,
      {
        sessionId: input.sessionId,
        pluginId: input.pluginId,
        phase: input.phase,
        ...(input.error ? { error: input.error } : {}),
      },
      input.pluginAuthToken,
    );
    return { ok: true };
  } catch (err) {
    const e = err as Error & { statusCode?: number };
    return {
      ok: false,
      status: typeof e.statusCode === 'number' ? e.statusCode : 0,
      message: e.message || 'unknown',
    };
  }
}

/**
 * Signal Beads provisioning status so the backend can emit a
 * `beads_provisioning` UserEvent (D13). The backend side is built in parallel;
 * this matches its contract: `POST /api/beads/provisioning` with plugin auth,
 * body `{ sessionId, pluginId, status, projectKey? }`. Strictly non-fatal — a
 * failure here never blocks provisioning; we swallow + report it.
 */
export async function postBeadsProvisioning(input: {
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  status: BeadsProvisioningStatus;
  projectKey?: string;
}): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  try {
    await _transport.postJsonAuthed(
      `${API_BASE}/api/beads/provisioning`,
      // The CLI is the producer of this hop — the body is the shared wire
      // shape (`@codeam/shared` `BeadsProvisioningPayload`), validated here.
      {
        sessionId: input.sessionId,
        pluginId: input.pluginId,
        status: input.status,
        ...(input.projectKey ? { projectKey: input.projectKey } : {}),
      } satisfies BeadsProvisioningPayload,
      input.pluginAuthToken,
    );
    return { ok: true };
  } catch (err) {
    const e = err as Error & { statusCode?: number };
    return {
      ok: false,
      status: typeof e.statusCode === 'number' ? e.statusCode : 0,
      message: e.message || 'unknown',
    };
  }
}

/**
 * Variant of `_postJson` that includes the X-Plugin-Auth-Token
 * header and surfaces the HTTP status code on the rejected error
 * so the caller can map 401/403/404 to specific user messages.
 */
export async function _postJsonAuthed(
  url: string,
  body: Record<string, unknown>,
  pluginAuthToken: string,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const transport = u.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'X-Plugin-Auth-Token': pluginAuthToken,
          ...vercelBypassHeader(),
        },
        timeout: 15000,
      },
      (res) => {
        res.on('error', reject);
        let responseBody = '';
        res.on('data', (chunk: Buffer) => {
          responseBody += chunk.toString();
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(makeHttpError(res.statusCode, res.headers['retry-after'], responseBody));
            return;
          }
          try {
            resolve(JSON.parse(responseBody));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.write(data);
    req.end();
  });
}

/**
 * Build an HTTP error that carries the status code + parsed
 * `Retry-After` header (in seconds) + the RAW response body. Used by every
 * transport function in this module so callers can distinguish a real
 * network failure from a rate-limit / auth / 4xx response without
 * regex'ing the message string. The `message` embeds only the first 200
 * chars of the body (log-friendly); `body` carries it in FULL so a caller
 * that needs the backend's structured `{code, message}` JSON (see
 * `fetchProvisionCredentialDetailed`) can parse it without truncation risk.
 */
function makeHttpError(
  statusCode: number,
  retryAfterHeader: string | string[] | undefined,
  responseBody: string,
): Error & { statusCode: number; retryAfterSeconds?: number; body?: string } {
  const raw = Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader;
  const retryAfterSeconds = raw && /^\d+$/.test(raw.trim()) ? Number.parseInt(raw, 10) : undefined;
  const err = new Error(
    `HTTP ${statusCode}${responseBody ? ': ' + responseBody.slice(0, 200) : ''}`,
  ) as Error & { statusCode: number; retryAfterSeconds?: number; body?: string };
  err.statusCode = statusCode;
  if (typeof retryAfterSeconds === 'number') err.retryAfterSeconds = retryAfterSeconds;
  if (responseBody) err.body = responseBody;
  return err;
}

// Exported with underscore prefix so tests can spy on them
export async function _postJson(
  url: string,
  body: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const transport = u.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...vercelBypassHeader(),
          ...(extraHeaders ?? {}),
        },
        timeout: 10000,
      },
      (res) => {
        res.on('error', reject);
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(makeHttpError(res.statusCode, res.headers['retry-after'], body));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.write(data);
    req.end();
  });
}

export async function _getJson(
  url: string,
  extraHeaders?: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const transport = u.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers: { ...vercelBypassHeader(), ...(extraHeaders ?? {}) },
        timeout: 10000,
      },
      (res) => {
        res.on('error', reject);
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(makeHttpError(res.statusCode, res.headers['retry-after'], body));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end();
  });
}
