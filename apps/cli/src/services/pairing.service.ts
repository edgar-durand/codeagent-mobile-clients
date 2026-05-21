import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
import { DEFAULT_API_BASE_URL } from '@codeagent/shared';
import pkg from '../../package.json';
import { vercelBypassHeader } from '../lib/backend-headers';
import { detectCurrentBranch } from '../lib/git-branch';
import { computePollDelay } from '../lib/poll-delay';

const API_BASE = process.env.CODEAM_API_URL ?? DEFAULT_API_BASE_URL;

export interface PairedUserInfo {
  sessionId: string;
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

export async function requestCode(
  pluginId: string,
): Promise<{ code: string; expiresAt: number } | null> {
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
    const result = await _transport.postJson(`${API_BASE}/api/pairing/code`, {
      pluginId,
      ideName: 'Terminal (codeam-cli)',
      ideVersion: pkg.version,
      hostname: os.hostname(),
      runtime,
      branch,
      ...(codespaceName ? { codespaceName } : {}),
    });
    const data = result?.data as Record<string, unknown> | undefined;
    if (!data?.code) return null;
    return { code: data.code as string, expiresAt: data.expiresAt as number };
  } catch {
    return null;
  }
}

export function pollStatus(
  pluginId: string,
  onPaired: (info: PairedUserInfo) => void,
  onTimeout: () => void,
): () => void {
  let stopped = false;
  let pollTimer: NodeJS.Timeout | null = null;
  let consecutiveFailures = 0;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      // Call through _transport so vi.spyOn can intercept in tests
      const result = await _transport.getJson(
        `${API_BASE}/api/pairing/status?pluginId=${pluginId}`,
      );
      consecutiveFailures = 0;
      const data = result?.data as Record<string, unknown> | undefined;
      if (data?.paired) {
        stop();
        const user = (data.user as Record<string, unknown>) ?? {};
        const rawToken = data.pluginAuthToken;
        onPaired({
          sessionId: data.sessionId as string,
          userName: (user.name as string) || '',
          userEmail: (user.email as string) || '',
          plan: (user.plan as string) || 'FREE',
          pluginAuthToken: typeof rawToken === 'string' && rawToken.length > 0 ? rawToken : undefined,
        });
        return;
      }
    } catch {
      consecutiveFailures += 1;
    }
    if (stopped) return;
    const delay = computePollDelay({ baseMs: 3000, failures: consecutiveFailures });
    pollTimer = setTimeout(() => { void tick(); }, delay);
  };

  const initialDelay = computePollDelay({ baseMs: 3000, failures: 0 });
  pollTimer = setTimeout(() => { void tick(); }, initialDelay);

  const timeout = setTimeout(() => {
    stop();
    onTimeout();
  }, 300_000);

  function stop() {
    stopped = true;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    clearTimeout(timeout);
  }

  return stop;
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
  agentId: 'claude_code' | 'codex';
  sessionId: string;
  pluginId: string;
  pluginAuthToken: string;
  method: 'oauth' | 'api_key';
  credential: string;
  modelPreference?: string;
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
 * Variant of `_postJson` that includes the X-Plugin-Auth-Token
 * header and surfaces the HTTP status code on the rejected error
 * so the caller can map 401/403/404 to specific user messages.
 */
async function _postJsonAuthed(
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
            const err = new Error(`HTTP ${res.statusCode}: ${responseBody.slice(0, 200)}`) as Error & {
              statusCode: number;
            };
            err.statusCode = res.statusCode;
            reject(err);
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

// Exported with underscore prefix so tests can spy on them
export async function _postJson(
  url: string,
  body: Record<string, unknown>,
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
        },
        timeout: 10000,
      },
      (res) => {
        res.on('error', reject);
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}`));
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
        headers: { ...vercelBypassHeader() },
        timeout: 10000,
      },
      (res) => {
        res.on('error', reject);
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}`));
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
