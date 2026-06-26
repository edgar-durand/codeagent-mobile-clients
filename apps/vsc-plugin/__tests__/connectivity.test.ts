import { describe, it, expect, vi, afterEach } from 'vitest';
import * as http from 'node:http';

afterEach(() => vi.restoreAllMocks());

describe('checkApiReachable', () => {
  it("returns 'reachable' when the server sends ANY HTTP response (even 500)", async () => {
    const server = http.createServer((_req, res) => { res.statusCode = 500; res.end('boom'); });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as import('net').AddressInfo).port;
    const { checkApiReachable } = await import('../src/services/connectivity');
    const result = await checkApiReachable(`http://127.0.0.1:${port}`);
    await new Promise<void>((r) => server.close(() => r()));
    expect(result).toBe('reachable');
  });

  it("returns 'blocked' when the connection cannot be established", async () => {
    const { checkApiReachable } = await import('../src/services/connectivity');
    // 203.0.113.x is TEST-NET-3 (RFC 5737) — unroutable; connect fails fast.
    const result = await checkApiReachable('http://203.0.113.1:9', 800);
    expect(result).toBe('blocked');
  });

  it("returns 'blocked' on timeout", async () => {
    const server = http.createServer(() => { /* never respond */ });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as import('net').AddressInfo).port;
    const { checkApiReachable } = await import('../src/services/connectivity');
    const result = await checkApiReachable(`http://127.0.0.1:${port}`, 300);
    await new Promise<void>((r) => server.close(() => r()));
    expect(result).toBe('blocked');
  });
});
