import * as http from 'node:http';
import * as https from 'node:https';

export type Reachability = 'reachable' | 'blocked';

/**
 * The ONE detection primitive: did we get any HTTP response from our API?
 *   - any status (incl. 4xx/5xx) → 'reachable'
 *   - transport error / timeout / no response → 'blocked'
 * Probes the public, unauthenticated `GET /healthz` (root path, not /api).
 * Short timeout so a blocked network fails fast.
 */
export async function checkApiReachable(
  apiBaseUrl: string,
  timeoutMs = 3500,
): Promise<Reachability> {
  return new Promise<Reachability>((resolve) => {
    let settled = false;
    const done = (r: Reachability) => { if (!settled) { settled = true; resolve(r); } };
    let url: URL;
    try {
      url = new URL('/healthz', apiBaseUrl);
    } catch {
      done('blocked');
      return;
    }
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'GET',
        timeout: timeoutMs,
      },
      (res: http.IncomingMessage) => {
        // Any HTTP response means the server is reachable. Drain + resolve.
        res.resume();
        res.on('end', () => done('reachable'));
        res.on('error', () => done('reachable')); // headers already arrived
      },
    );
    req.on('error', () => done('blocked'));
    req.on('timeout', () => { req.destroy(); done('blocked'); });
    req.end();
  });
}
