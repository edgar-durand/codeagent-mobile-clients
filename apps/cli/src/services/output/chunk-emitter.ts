import * as https from 'https';
import * as http from 'http';
import { vercelBypassHeader } from '../../lib/backend-headers';
import { log } from '../logger';

const API_BASE = process.env.CODEAM_API_URL ?? 'https://api.codeagent-mobile.com';

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

  constructor(private readonly opts: ChunkEmitterOptions) {
    this.headers = {
      'Content-Type': 'application/json',
      // Tell the backend which wire-format version we speak so
      // it can route legacy translations / 426 us when we're
      // too far behind. Bumped to 2.0.0 with the discriminated-
      // chunk + delta-chrome refactor in this release.
      'X-Codeam-Protocol-Version': '2.0.0',
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

    return new Promise((resolve) => {
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
