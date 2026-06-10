import { afterEach, describe, expect, it } from 'vitest';
import * as net from 'net';
import { waitForPortListening } from '../../src/services/preview/port-ready';

/**
 * BUG 1 (preview hangs on "waiting for ready signal"): when the
 * agent's `ready_pattern` doesn't match the dev server's real output
 * (e.g. Next.js prints `▲ Next.js 14.x` / `- Local: http://...` rather
 * than a "ready" line), the regex watcher times out at 120 s while the
 * server is actually listening. The port-listening probe is the
 * additive fallback: if something is accepting TCP connections on the
 * detected port, the preview IS ready regardless of stdout wording.
 */
describe('waitForPortListening', () => {
  const servers: net.Server[] = [];

  afterEach(async () => {
    for (const s of servers) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    servers.length = 0;
  });

  function listenOnEphemeralPort(): Promise<number> {
    return new Promise((resolve) => {
      const server = net.createServer();
      servers.push(server);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') resolve(addr.port);
      });
    });
  }

  it('resolves true once a server is listening on the port', async () => {
    const port = await listenOnEphemeralPort();
    const ready = await waitForPortListening(port, { timeoutMs: 2_000, intervalMs: 50 });
    expect(ready).toBe(true);
  });

  it('resolves false when nothing ever listens within the timeout', async () => {
    // An ephemeral port we open then immediately close → guaranteed
    // closed, no risk of colliding with a real service.
    const port = await listenOnEphemeralPort();
    await new Promise<void>((resolve) => servers[0].close(() => resolve()));
    servers.length = 0;

    const ready = await waitForPortListening(port, { timeoutMs: 400, intervalMs: 50 });
    expect(ready).toBe(false);
  });

  it('resolves true when a server comes up partway through the wait', async () => {
    const port = 0;
    // Reserve a concrete port first, close it, then re-bind after a delay.
    const reserved = await listenOnEphemeralPort();
    await new Promise<void>((resolve) => servers[0].close(() => resolve()));
    servers.length = 0;

    const waitP = waitForPortListening(reserved, { timeoutMs: 3_000, intervalMs: 50 });
    setTimeout(() => {
      const late = net.createServer();
      servers.push(late);
      late.listen(reserved, '127.0.0.1');
    }, 300);
    void port;

    expect(await waitP).toBe(true);
  });
});
