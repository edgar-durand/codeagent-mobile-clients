import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
import { resolveApiBaseUrl } from '@codeam/shared';
import pkg from '../../package.json';
import { vercelBypassHeader } from '../lib/backend-headers';
import { detectCurrentBranch } from '../lib/git-branch';
import { computePollDelay } from '../lib/poll-delay';

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
      hostname: os.hostname(),
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
  status: 'ready' | 'failed';
  projectKey?: string;
}): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  try {
    await _transport.postJsonAuthed(
      `${API_BASE}/api/beads/provisioning`,
      {
        sessionId: input.sessionId,
        pluginId: input.pluginId,
        status: input.status,
        ...(input.projectKey ? { projectKey: input.projectKey } : {}),
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
        res.on('data', (chunk: Buffer) => { responseBody += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(
              makeHttpError(res.statusCode, res.headers['retry-after'], responseBody),
            );
            return;
          }
          try { resolve(JSON.parse(responseBody)); } catch { resolve(null); }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

/**
 * Build an HTTP error that carries the status code + parsed
 * `Retry-After` header (in seconds). Used by every transport
 * function in this module so callers can distinguish a real
 * network failure from a rate-limit / auth / 4xx response without
 * regex'ing the message string.
 */
function makeHttpError(
  statusCode: number,
  retryAfterHeader: string | string[] | undefined,
  responseBody: string,
): Error & { statusCode: number; retryAfterSeconds?: number } {
  const raw = Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader;
  const retryAfterSeconds =
    raw && /^\d+$/.test(raw.trim()) ? Number.parseInt(raw, 10) : undefined;
  const err = new Error(
    `HTTP ${statusCode}${responseBody ? ': ' + responseBody.slice(0, 200) : ''}`,
  ) as Error & { statusCode: number; retryAfterSeconds?: number };
  err.statusCode = statusCode;
  if (typeof retryAfterSeconds === 'number') err.retryAfterSeconds = retryAfterSeconds;
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
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(makeHttpError(res.statusCode, res.headers['retry-after'], body));
            return;
          }
          try { resolve(JSON.parse(body)); } catch { resolve(null); }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
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
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(makeHttpError(res.statusCode, res.headers['retry-after'], body));
            return;
          }
          try { resolve(JSON.parse(body)); } catch { resolve(null); }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}
