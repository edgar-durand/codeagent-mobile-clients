import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import {
  publicLocation,
  startInspectorProxy,
  upstreamRequestHeaders,
  type InspectorProxy,
} from '../../src/services/preview/inspector-proxy';

/**
 * QA Box 2026-09-25: Vite answered `403 Blocked request. This host
 * ("x.trycloudflare.com") is not allowed` because its config lives in a
 * monorepo package where `host-allow` never looks. The proxy now hands the dev
 * server its own `localhost:<port>` as Host, like any `changeOrigin` proxy.
 */

let origin: http.Server;
let originPort = 0;
let proxy: InspectorProxy;

beforeAll(async () => {
  // A dev server with Vite's host check.
  origin = http.createServer((req, res) => {
    if (req.headers.host !== `localhost:${originPort}`) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end(`Blocked request. This host ("${req.headers.host}") is not allowed.`);
      return;
    }
    if (req.url === '/old') {
      res.writeHead(302, { location: `http://localhost:${originPort}/login` });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ forwardedHost: req.headers['x-forwarded-host'] ?? null }));
  });
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', () => r()));
  originPort = (origin.address() as AddressInfo).port;
  proxy = await startInspectorProxy({ targetPort: originPort, script: '<script></script>' });
});

afterAll(async () => {
  await proxy.close();
  await new Promise<void>((r) => origin.close(() => r()));
});

function get(path: string): Promise<{ status: number; body: string; location?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxy.port,
        path,
        headers: { host: 'demo.trycloudflare.com', accept: 'application/json' },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body, location: res.headers.location }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('inspector proxy — the tunnel host never reaches the dev server', () => {
  it('passes a dev server that only accepts its own host, and forwards the public one', async () => {
    const r = await get('/api');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ forwardedHost: 'demo.trycloudflare.com' });
  });

  it('keeps a redirect on the public URL instead of the box loopback', async () => {
    const r = await get('/old');
    expect(r.status).toBe(302);
    expect(r.location).toBe('/login');
  });
});

describe('upstreamRequestHeaders / publicLocation', () => {
  it('keeps an X-Forwarded-Host that is already set', () => {
    expect(
      upstreamRequestHeaders({ host: 'a.example', 'x-forwarded-host': 'b.example' }, 5174),
    ).toMatchObject({ host: 'localhost:5174', 'x-forwarded-host': 'b.example' });
  });

  it('leaves external and other-port redirects alone', () => {
    expect(publicLocation('https://github.com/login', 5174)).toBe('https://github.com/login');
    expect(publicLocation('http://localhost:3000/x', 5174)).toBe('http://localhost:3000/x');
    expect(publicLocation('http://[::1]:5174', 5174)).toBe('/');
  });
});
