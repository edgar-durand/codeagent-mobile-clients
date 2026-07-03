import * as https from 'https';
import * as http from 'http';
import { resolveApiBaseUrl, PROTOCOL_VERSION } from '@codeagent/shared';
import { vercelBypassHeader } from '../../lib/backend-headers';
import { log } from '../logger';

const API_BASE = resolveApiBaseUrl();

/**
 * Silent token-refresh helper. The HMAC token the CLI holds is
 * deterministic against JWT_SECRET — when the backend rotates that
 * secret OR a stale token replays against a re-paired session, the
 * `/api/pairing/reconnect` endpoint re-derives a fresh one as long
 * as the session row still exists. Returns the new token on
 * success, null when the session is gone or the call fails.
 *
 * Workflow continuity is a hard product invariant: the CLI must
 * NEVER interrupt the user with a "re-pair" prompt when the
 * backend can mint a fresh token from the same (sessionId,
 * pluginId) tuple it minted the previous one from.
 */
type RefreshOutcome =
  | { kind: 'fresh'; token: string }
  | { kind: 'gone' }
  | { kind: 'transient' };

async function refreshAuthToken(
  sessionId: string,
  pluginId: string,
): Promise<RefreshOutcome> {
  try {
    const { statusCode, body } = await _transport.post(
      `${API_BASE}/api/pairing/reconnect`,
      {
        'Content-Type': 'application/json',
        'X-Codeam-Protocol-Version': PROTOCOL_VERSION,
        ...vercelBypassHeader(),
      },
      JSON.stringify({ sessionId, pluginId }),
    );
    // 404/401/403 = the pairing itself is GONE server-side — no amount
    // of retrying mints a token for a deleted session. Anything else
    // (5xx, network, malformed body) is transient: keep the session
    // alive and let the next emit try again.
    if (statusCode === 404 || statusCode === 401 || statusCode === 403) {
      log.warn('chunkEmitter', `[auth] reconnect ${statusCode} — session gone server-side`);
      return { kind: 'gone' };
    }
    if (statusCode >= 400) {
      log.warn('chunkEmitter', `[auth] reconnect failed status=${statusCode}`);
      return { kind: 'transient' };
    }
    const parsed = JSON.parse(body) as { data?: { pluginAuthToken?: unknown } };
    const fresh = parsed.data?.pluginAuthToken;
    if (typeof fresh !== 'string' || fresh.length === 0) {
      log.warn('chunkEmitter', '[auth] reconnect response missing pluginAuthToken');
      return { kind: 'transient' };
    }
    return { kind: 'fresh', token: fresh };
  } catch (err) {
    log.warn('chunkEmitter', `[auth] reconnect threw: ${String(err)}`);
    return { kind: 'transient' };
  }
}

/**
 * Hand-rolled HTTP transport for chunk POSTs to
 * `/api/commands/output`. Owns:
 *   - retries on critical chunks (`new_turn`, `done:true`, `clear`)
 *   - the `X-Plugin-Auth-Token` header negotiation
 *   - 410 Gone detection (stops the pump when the session is dead)
 *
 * Pure transport — does not understand chunk semantics beyond
 * "is this critical" (caller decides). Returns a `dead` signal
 * the caller uses to deactivate the upstream tick loop.
 */

export interface ChunkEmitterOptions {
  sessionId: string;
  pluginId: string;
  pluginAuthToken?: string;
}

export interface SendOutcome {
  /** Server returned 410 Gone or session-not-found — stop pushing. */
  dead: boolean;
}

export class ChunkEmitter {
  private readonly url = `${API_BASE}/api/commands/output`;
  private readonly headers: Record<string, string>;
  /** Latched when the pairing is unrecoverable (401/403 whose refresh
   *  says the session is gone, or a fresh token still rejected) —
   *  every later send short-circuits (2026-06-28 incident: 401 ×34
   *  with a dead token while the user saw nothing). */
  private pairingInvalid = false;

  constructor(private readonly opts: ChunkEmitterOptions) {
    this.headers = {
      'Content-Type': 'application/json',
      'X-Codeam-Protocol-Version': PROTOCOL_VERSION,
      ...vercelBypassHeader(),
    };
    if (opts.pluginAuthToken) {
      this.headers['X-Plugin-Auth-Token'] = opts.pluginAuthToken;
    }
  }

  /**
   * Send a chunk. `body` is the chunk fields minus `sessionId` /
   * `pluginId` — the emitter splices those in. `critical = true`
   * triggers up to 3 retries with linear backoff (200/400/600 ms);
   * non-critical sends are best-effort (a transient miss gets
   * superseded by the next tick's emission).
   */
  async send(
    body: Record<string, unknown>,
    opts: { critical?: boolean } = {},
  ): Promise<SendOutcome> {
    const payload = JSON.stringify({
      sessionId: this.opts.sessionId,
      pluginId: this.opts.pluginId,
      ...body,
    });
    const maxRetries = opts.critical ? 3 : 0;

    // info-level so it lands in the always-on file log — chunk
    // outcomes are the most useful breadcrumb for diagnosing
    // "mobile didn't see my agent reply" reports.
    const t0 = Date.now();
    log.info(
      'chunkEmitter',
      `send type=${(body.type as string) ?? '(clear)'} bytes=${payload.length} done=${body.done === true}`,
    );

    if (this.pairingInvalid) {
      // Latched — the pairing is gone; don't spam the API with a dead
      // token. `dead: true` tells the upstream pump to stop too.
      return Promise.resolve({ dead: true });
    }

    return new Promise((resolve) => {
      // At most ONE post-refresh retry per send — a fresh token that is
      // STILL rejected means the pairing itself is invalid, not the
      // token, and looping refresh→retry would 401-spam forever.
      let refreshedOnce = false;
      const attempt = (attemptsLeft: number) => {
        _transport.post(this.url, this.headers, payload)
          .then(({ statusCode, body: resBody }) => {
            const tookMs = Date.now() - t0;
            if (
              statusCode === 410 ||
              (statusCode === 404 && /SESSION_NOT_FOUND|SESSION_GONE/.test(resBody))
            ) {
              process.stderr.write('[codeam] session was deleted/disconnected — stopping output stream.\n');
              log.info('chunkEmitter', `dead status=${statusCode} took=${tookMs}ms`);
              resolve({ dead: true });
              return;
            }
            if (statusCode === 401 || statusCode === 403) {
              // Silent token refresh first — workflow continuity says we
              // never interrupt a RECOVERABLE session. Fatal only when
              // the refresh reports the pairing gone, or a fresh token
              // is still rejected.
              if (refreshedOnce) {
                this.markPairingInvalid(statusCode, tookMs);
                resolve({ dead: true });
                return;
              }
              log.warn('chunkEmitter', `auth ${statusCode} took=${tookMs}ms — attempting silent refresh`);
              void (async () => {
                const refresh = await refreshAuthToken(this.opts.sessionId, this.opts.pluginId);
                if (refresh.kind === 'fresh') {
                  this.headers['X-Plugin-Auth-Token'] = refresh.token;
                  this.opts.pluginAuthToken = refresh.token;
                  refreshedOnce = true;
                  log.info('chunkEmitter', 'auth refreshed silently');
                  attempt(Math.max(attemptsLeft, 1));
                  return;
                }
                if (refresh.kind === 'gone') {
                  this.markPairingInvalid(statusCode, tookMs);
                  resolve({ dead: true });
                  return;
                }
                // Transient refresh failure — stay alive, next emit re-tries.
                resolve({ dead: false });
              })();
              return;
            }
            if (statusCode >= 400) {
              log.warn('chunkEmitter', `api-error status=${statusCode} took=${tookMs}ms body=${resBody.slice(0, 200)}`);
              process.stderr.write(`[codeam] output API error ${statusCode}: ${resBody}\n`);
            } else {
              log.info('chunkEmitter', `ok status=${statusCode} took=${tookMs}ms`);
            }
            resolve({ dead: false });
          })
          .catch((err: unknown) => {
            log.warn(
              'chunkEmitter',
              `error retries-left=${attemptsLeft} took=${Date.now() - t0}ms`,
              err,
            );
            if (attemptsLeft > 0) {
              const delay = 200 * (maxRetries - attemptsLeft + 1);
              setTimeout(() => attempt(attemptsLeft - 1), delay);
            } else {
              resolve({ dead: false });
            }
          });
      };
      attempt(maxRetries);
    });
  }

  private markPairingInvalid(statusCode: number, tookMs: number): void {
    if (this.pairingInvalid) return;
    this.pairingInvalid = true;
    process.stderr.write(
      '[codeam] This pairing is no longer valid — run `codeam pair` again to reconnect this session.\n',
    );
    log.warn(
      'chunkEmitter',
      `pairing invalid (status=${statusCode}) took=${tookMs}ms — emitter latched, no further posts`,
    );
  }
}

/**
 * Transport seam — exposed so unit tests can stub the network
 * without monkey-patching Node's `http`/`https` modules.
 */
export const _transport = {
  post: _post,
};

export function _post(
  url: string,
  headers: Record<string, string>,
  payload: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const u = new URL(url);
    const transport = u.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 8000,
      },
      (res) => {
        let resData = '';
        res.on('data', (c: Buffer) => { resData += c.toString(); });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({ statusCode: res.statusCode ?? 0, body: resData });
        });
      },
    );
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    req.on('timeout', () => { req.destroy(); });
    req.write(payload);
    req.end();
  });
}
