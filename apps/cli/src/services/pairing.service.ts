import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
import pkg from '../../package.json';

const API_BASE = process.env.CODEAM_API_URL ?? 'https://codeagent-mobile-api.vercel.app';

export interface PairedUserInfo {
  sessionId: string;
  userName: string;
  userEmail: string;
  plan: string;
}

export async function requestCode(
  pluginId: string,
): Promise<{ code: string; expiresAt: number } | null> {
  try {
    // Call through _transport so vi.spyOn can intercept in tests
    const result = await _transport.postJson(`${API_BASE}/api/pairing/code`, {
      pluginId,
      ideName: 'Terminal (codeam-cli)',
      ideVersion: pkg.version,
      hostname: os.hostname(),
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

  const interval = setInterval(async () => {
    if (stopped) return;
    try {
      // Call through _transport so vi.spyOn can intercept in tests
      const result = await _transport.getJson(
        `${API_BASE}/api/pairing/status?pluginId=${pluginId}`,
      );
      const data = result?.data as Record<string, unknown> | undefined;
      if (data?.paired) {
        stop();
        const user = (data.user as Record<string, unknown>) ?? {};
        onPaired({
          sessionId: data.sessionId as string,
          userName: (user.name as string) || '',
          userEmail: (user.email as string) || '',
          plan: (user.plan as string) || 'FREE',
        });
      }
    } catch { /* silent */ }
  }, 3000);

  const timeout = setTimeout(() => {
    stop();
    onTimeout();
  }, 300_000);

  function stop() {
    stopped = true;
    clearInterval(interval);
    clearTimeout(timeout);
  }

  return stop;
}

// Exported transport object — allows tests to spy on individual methods without
// relying on CommonJS `exports` (which breaks in bundled output)
export const _transport = {
  postJson: _postJson,
  getJson: _getJson,
};

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
