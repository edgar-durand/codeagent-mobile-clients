import * as http from 'http';
import * as https from 'https';
import { vercelBypassHeader } from '../../lib/backend-headers';

/**
 * Hand-rolled HTTP transport for the Epic C streaming-emitter. Same
 * shape as `services/file-watcher/transport.ts` — node:http /
 * node:https only, no third-party client, easy to stub in tests via
 * the `_transport` object.
 *
 * Splitting the transport into its own module keeps the emitter
 * service free of `URL`/`http` boilerplate and lets vitest
 * `vi.spyOn(_transport, 'post')` without monkey-patching globals.
 */

export interface PostResult {
  statusCode: number;
  body: string;
}

export interface GetResult {
  statusCode: number;
  body: string;
}

export const _transport = {
  post: _post,
  get: _get,
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
        res.on('data', (c: Buffer) => {
          body += c.toString();
        });
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
    req.on('timeout', () => {
      req.destroy();
    });
    req.write(payload);
    req.end();
  });
}

export function _get(url: string, headers: Record<string, string>): Promise<GetResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          ...headers,
          ...vercelBypassHeader(),
        },
        timeout: 8000,
      },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => {
          body += c.toString();
        });
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
    req.on('timeout', () => {
      req.destroy();
    });
    req.end();
  });
}
