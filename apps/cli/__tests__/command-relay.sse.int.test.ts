/**
 * Integration test for the command relay's SSE PRIMARY channel — the realtime
 * path that delivers every mobile→CLI command. Coverage audit (2026-08-11) found
 * it near-untested: `start()` short-circuits to polling under NODE_ENV=test, so
 * `connectSSE()` (connect → parse `event: commands` frames → dispatch → ack →
 * dedupe → 2-failure fallback) had no test and could regress silently.
 *
 * This drives the REAL `connectSSE()` against a REAL local HTTP server emitting
 * real SSE frames (no socket mocking) — the ack POST is the one boundary we fake
 * (via the already-mocked `pairing._postJson`) so we can assert what got acked.
 * API_BASE is a module const resolved from CODEAM_API_URL at import, so we set
 * the env to the ephemeral server port and dynamic-import the service per test.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AGENT_REGISTRY } from '@codeam/shared';
import * as pairing from '../src/services/pairing.service';

vi.mock('../src/services/pairing.service', () => ({
  _postJson: vi.fn().mockResolvedValue({ success: true }),
  _getJson: vi.fn().mockResolvedValue({ data: [] }),
}));

const META = AGENT_REGISTRY.claude;
const commandsFrame = (commands: unknown[]): string =>
  `event: commands\ndata: ${JSON.stringify({ commands })}\n\n`;

async function startServer(
  onStream: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url?.includes('/api/commands/pending/stream')) return onStream(req, res);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// Fresh module (with API_BASE bound to `port`) + a started, SSE-connected relay.
async function connectedRelay(port: number, onCmd: (c: unknown) => void) {
  process.env.CODEAM_API_URL = `http://127.0.0.1:${port}`;
  vi.resetModules();
  const { CommandRelayService } = await import('../src/services/command-relay.service');
  const relay = new CommandRelayService('plugin-sse-int', onCmd as never, META);
  // Bypass start() (which forces polling under NODE_ENV=test) and drive the SSE
  // path directly — that IS the code under test.
  (relay as unknown as { _running: boolean })._running = true;
  return relay as unknown as { connectSSE(): void; stop(): void; sseFailures: number };
}

describe('command-relay SSE primary path (integration, real socket)', () => {
  afterEach(async () => {
    delete process.env.CODEAM_API_URL;
    vi.clearAllMocks();
  });

  it('dispatches a command received on the SSE stream, acks it, and dedupes a redelivery', async () => {
    let streamRes: http.ServerResponse | null = null;
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      streamRes = res;
    });
    const onCmd = vi.fn();
    const relay = await connectedRelay(srv.port, onCmd);
    relay.connectSSE();

    // Wait for the stream to be established, then push a real command frame.
    await vi.waitFor(() => expect(streamRes).not.toBeNull(), { timeout: 3000 });
    streamRes!.write(commandsFrame([{ id: 'c1', type: 'start_task', payload: {} }]));

    await vi.waitFor(() => expect(onCmd).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(onCmd.mock.calls[0][0]).toMatchObject({ id: 'c1', type: 'start_task' });
    // at-least-once delivery → the id is acked so the backend drains its queue.
    expect(pairing._postJson).toHaveBeenCalledWith(
      expect.stringContaining('/api/commands/ack'),
      expect.objectContaining({ commandIds: ['c1'] }),
      expect.anything(),
    );

    // REDELIVERY of the same id (reconnect / publish re-fire) must NOT re-run it.
    streamRes!.write(commandsFrame([{ id: 'c1', type: 'start_task', payload: {} }]));
    await new Promise((r) => setTimeout(r, 200));
    expect(onCmd).toHaveBeenCalledTimes(1);

    relay.stop();
    await srv.close();
  });

  it('falls back to polling after 2 consecutive SSE connect failures (non-200)', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    const onCmd = vi.fn();
    const relay = await connectedRelay(srv.port, onCmd);
    const fallback = vi.spyOn(
      relay as unknown as { startPollingFallback: () => void },
      'startPollingFallback',
    );
    // Pre-seed one prior failure so the single 503 here crosses the 2-failure
    // threshold deterministically (no waiting on the reconnect backoff timer).
    relay.sseFailures = 1;
    relay.connectSSE();

    await vi.waitFor(() => expect(fallback).toHaveBeenCalledTimes(1), { timeout: 3000 });

    relay.stop();
    await srv.close();
  });
});
