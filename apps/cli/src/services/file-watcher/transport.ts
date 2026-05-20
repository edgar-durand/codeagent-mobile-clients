import * as http from 'http';
import * as https from 'https';
import { vercelBypassHeader } from '../../lib/backend-headers';

/**
 * Hand-rolled HTTP POST for file-watcher emissions. Matches the
 * pattern used by `chunk-emitter` and `pairing.service` — node:http /
 * node:https only, no third-party client, easy to stub in tests.
 *
 * Exported as a `_transport` object so vitest can `vi.spyOn` the
 * `post` method without monkey-patching node's http modules. Same
 * convention as `output/chunk-emitter.ts` and `pairing.service.ts`.
 */

export interface PostResult {
  statusCode: number;
  body: string;
}

export const _transport = {
  post: _post,
};

export function _post(
  url: string,
  headers: Record<string, string>,
  payload: string,
): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          ...headers,
          ...vercelBypassHeader(),
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 8000,
      },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => { body += c.toString(); });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({ statusCode: res.statusCode ?? 0, body });
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
