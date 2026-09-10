/**
 * Pre-pair `pair_completed` subscriber × the api/stream host split.
 *
 * It opens the same `GET /api/commands/pending/stream` the relay does, so it
 * moves to the stream host with the same one-time fallback — and because the
 * latch is process-wide, a fallback taken here while pairing is honoured by
 * the relay that starts right after (same module graph, no reset between).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

const STREAM_PATH = '/api/commands/pending/stream';

interface FakeTier {
  base: string;
  streamHits: number;
  close: () => Promise<void>;
}

async function startTier(
  onStream: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<FakeTier> {
  const tier: FakeTier = { base: '', streamHits: 0, close: async () => undefined };
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith(STREAM_PATH)) {
      tier.streamHits += 1;
      return onStream(req, res);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  tier.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  tier.close = () => new Promise<void>((r) => server.close(() => r()));
  return tier;
}

const pairCompletedFrame = (pluginId: string): string =>
  `event: commands\ndata: ${JSON.stringify({
    commands: [
      {
        id: 'cmd-1',
        type: 'pair_completed',
        pluginId,
        sessionId: 'session-xyz',
        payload: { sessionId: 'session-xyz', userName: 'Ada', pluginAuthToken: 'tok' },
      },
    ],
  })}\n\n`;

const servesPairCompleted =
  (pluginId: string) => (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: connected\ndata: {}\n\n');
    res.write(pairCompletedFrame(pluginId));
  };

async function freshSubscriber(apiBase: string, streamBase: string) {
  process.env.CODEAM_API_URL = apiBase;
  process.env.CODEAM_STREAM_URL = streamBase;
  vi.resetModules();
  const [{ subscribeToPairCompletion }, { streamHost }] = await Promise.all([
    import('../../src/services/pair-completion-subscriber'),
    import('../../src/services/stream-base-url'),
  ]);
  return { subscribeToPairCompletion, streamHost };
}

describe('pair-completion subscriber on the stream host (integration, real sockets)', () => {
  const tiers: FakeTier[] = [];
  const track = async (t: Promise<FakeTier>) => {
    const tier = await t;
    tiers.push(tier);
    return tier;
  };
  afterEach(async () => {
    delete process.env.CODEAM_API_URL;
    delete process.env.CODEAM_STREAM_URL;
    await Promise.all(tiers.splice(0).map((t) => t.close()));
  });

  it('subscribes on the stream host and resolves the pair from there', async () => {
    const api = await track(startTier(servesPairCompleted('plugin-a')));
    const stream = await track(startTier(servesPairCompleted('plugin-a')));
    const { subscribeToPairCompletion, streamHost } = await freshSubscriber(api.base, stream.base);

    const onPaired = vi.fn();
    const stop = subscribeToPairCompletion('plugin-a', onPaired, vi.fn());
    await vi.waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1), { timeout: 3000 });
    stop();

    expect(onPaired.mock.calls[0][0]).toMatchObject({ sessionId: 'session-xyz', userName: 'Ada' });
    expect(stream.streamHits).toBe(1);
    expect(api.streamHits).toBe(0);
    expect(streamHost.fellBack).toBe(false);
  });

  it('5xx from the stream host before any byte → api host, and the latch is process-wide', async () => {
    const api = await track(startTier(servesPairCompleted('plugin-b')));
    const stream = await track(
      startTier((_req, res) => {
        res.writeHead(525);
        res.end();
      }),
    );
    const { subscribeToPairCompletion, streamHost } = await freshSubscriber(api.base, stream.base);

    const onPaired = vi.fn();
    const stop = subscribeToPairCompletion('plugin-b', onPaired, vi.fn());
    await vi.waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1), { timeout: 3000 });
    stop();

    expect(stream.streamHits).toBe(1);
    expect(api.streamHits).toBe(1);
    // The relay that starts after pairing sees the same verdict.
    expect(streamHost.fellBack).toBe(true);
    expect(streamHost.current).toBe(api.base);
  });

  it('404 from the stream host never falls back — keeps its 1 s reconnect on the stream host', async () => {
    const api = await track(startTier(servesPairCompleted('plugin-c')));
    const stream = await track(
      startTier((_req, res) => {
        res.writeHead(404);
        res.end();
      }),
    );
    const { subscribeToPairCompletion, streamHost } = await freshSubscriber(api.base, stream.base);

    const onPaired = vi.fn();
    const stop = subscribeToPairCompletion('plugin-c', onPaired, vi.fn());
    await vi.waitFor(() => expect(stream.streamHits).toBeGreaterThanOrEqual(2), { timeout: 4000 });
    stop();

    expect(api.streamHits).toBe(0);
    expect(onPaired).not.toHaveBeenCalled();
    expect(streamHost.fellBack).toBe(false);
  });
});
