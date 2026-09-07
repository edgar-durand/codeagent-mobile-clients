/**
 * Expo preview helpers — the pieces that let an Expo preview ride OUR
 * cloudflared tunnel instead of Expo's ngrok one.
 *
 * WHY (2026-09-07): `expo start --tunnel` authenticates ngrok with the token
 * hardcoded in `@expo/cli`, shared by every anonymous Expo user. Whenever that
 * account sits at its 5000-session cap the ngrok agent exits
 * (`ERR_NGROK_108`), `@expo/ngrok` throws `Cannot read properties of undefined
 * (reading 'body')`, Expo exits 1 → our `ERR_SPAWN_FAILED`. It works whenever
 * the shared account dips under the cap — what a user saw as "start after stop
 * breaks". Nothing in our stop/start sequence caused it.
 */
import * as http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureExpoPortArg,
  expoGoDeepLink,
  expoSpawnArgs,
  isExpoManifestServed,
  stripExpoTunnelFlag,
  waitForExpoManifest,
} from '../../src/services/preview/expo';

describe('stripExpoTunnelFlag', () => {
  it('drops --tunnel wherever it sits, keeping everything else in order', () => {
    expect(stripExpoTunnelFlag(['expo', 'start', '--tunnel'])).toEqual(['expo', 'start']);
    expect(stripExpoTunnelFlag(['start', '--tunnel', '--port', '8081'])).toEqual([
      'start',
      '--port',
      '8081',
    ]);
    expect(stripExpoTunnelFlag(['run', 'start', '--', '--tunnel', '--clear'])).toEqual([
      'run',
      'start',
      '--',
      '--clear',
    ]);
  });

  it('drops the --tunnel=<value> form too', () => {
    expect(stripExpoTunnelFlag(['expo', 'start', '--tunnel=true'])).toEqual(['expo', 'start']);
  });

  it('leaves --localhost / --lan and unrelated args alone', () => {
    expect(stripExpoTunnelFlag(['expo', 'start', '--lan', '--clear'])).toEqual([
      'expo',
      'start',
      '--lan',
      '--clear',
    ]);
    expect(stripExpoTunnelFlag([])).toEqual([]);
  });
});

describe('ensureExpoPortArg', () => {
  it('appends --port <port> when the detection has none', () => {
    expect(ensureExpoPortArg('npx', ['expo', 'start'], 8081)).toEqual([
      'expo',
      'start',
      '--port',
      '8081',
    ]);
    expect(ensureExpoPortArg('/repo/node_modules/.bin/expo', ['start'], 19000)).toEqual([
      'start',
      '--port',
      '19000',
    ]);
  });

  it('keeps an existing --port (either form) untouched', () => {
    expect(ensureExpoPortArg('npx', ['expo', 'start', '--port', '8082'], 8081)).toEqual([
      'expo',
      'start',
      '--port',
      '8082',
    ]);
    expect(ensureExpoPortArg('npx', ['expo', 'start', '--port=8082'], 8081)).toEqual([
      'expo',
      'start',
      '--port=8082',
    ]);
  });

  it('routes the flag past npm run with `--` when the script is run through npm', () => {
    expect(ensureExpoPortArg('npm', ['run', 'start'], 8081)).toEqual([
      'run',
      'start',
      '--',
      '--port',
      '8081',
    ]);
    // Already has the separator → no second one.
    expect(ensureExpoPortArg('npm', ['run', 'start', '--', '--clear'], 8081)).toEqual([
      'run',
      'start',
      '--',
      '--clear',
      '--port',
      '8081',
    ]);
    // yarn forwards trailing args to the script implicitly.
    expect(ensureExpoPortArg('yarn', ['start'], 8081)).toEqual(['start', '--port', '8081']);
  });
});

describe('expoSpawnArgs', () => {
  it('strips --tunnel AND pins the port in one pass', () => {
    expect(expoSpawnArgs('npx', ['expo', 'start', '--tunnel'], 8081)).toEqual([
      'expo',
      'start',
      '--port',
      '8081',
    ]);
  });
});

describe('expoGoDeepLink', () => {
  it('maps the public https URL to the exps:// scheme Expo Go opens', () => {
    expect(expoGoDeepLink('https://host.example')).toBe('exps://host.example');
    expect(expoGoDeepLink('https://abc-def.trycloudflare.com/')).toBe(
      'exps://abc-def.trycloudflare.com',
    );
  });
});

describe('waitForExpoManifest', () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  async function listen(handler: http.RequestListener): Promise<number> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return (server.address() as AddressInfo).port;
  }

  it('resolves true once GET / with `expo-platform: ios` answers 2xx (the manifest)', async () => {
    let sawPlatformHeader = false;
    const port = await listen((req, res) => {
      // Metro without the header serves the dev-launcher HTML; WITH it, the
      // manifest JSON. The probe must ask like Expo Go does.
      sawPlatformHeader = req.headers['expo-platform'] === 'ios';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"name":"app"}');
    });
    expect(await waitForExpoManifest(port, { timeoutMs: 2_000, intervalMs: 50 })).toBe(true);
    expect(sawPlatformHeader).toBe(true);
  });

  it('keeps polling while the server is still booting (5xx) and resolves once it serves', async () => {
    let hits = 0;
    const port = await listen((_req, res) => {
      hits += 1;
      res.writeHead(hits < 3 ? 503 : 200);
      res.end();
    });
    expect(await waitForExpoManifest(port, { timeoutMs: 2_000, intervalMs: 20 })).toBe(true);
    expect(hits).toBeGreaterThanOrEqual(3);
  });

  it('resolves false when nothing listens on the port before the deadline', async () => {
    // Grab a free port then release it so the probe hits a closed socket.
    const port = await listen((_req, res) => res.end());
    await new Promise<void>((r) => servers.pop()!.close(() => r()));
    expect(await waitForExpoManifest(port, { timeoutMs: 400, intervalMs: 50 })).toBe(false);
  });

  it('isExpoManifestServed is a single shot: false on a non-2xx answer', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    expect(await isExpoManifestServed(port)).toBe(false);
  });
});
