/**
 * Command relay × the api/stream host split (plan 2026-09-10 Step 4).
 *
 * Two REAL local HTTP servers stand in for the two backend tiers:
 * `CODEAM_API_URL` → the api host, `CODEAM_STREAM_URL` → the stream host.
 * The relay must open ONLY `GET /api/commands/pending/stream` against the
 * stream host; every REST call (ack, heartbeat, agents, `/commands/pending`
 * polling) stays on the api host.
 *
 * Fallback ladder under test — the ordering is the point:
 *   stream host (network error / 5xx before any byte) → api host → polling.
 * Auth / 404 verdicts from the stream host never fall back (an `api`-role
 * tier answers 404 and that must stay visible), and a stream that delivered
 * then dropped reconnects on the stream host like before.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AGENT_REGISTRY } from '@codeam/shared';
import * as pairing from '../src/services/pairing.service';
import * as telemetry from '../src/services/telemetry.service';

vi.mock('../src/services/pairing.service', () => ({
  _postJson: vi.fn().mockResolvedValue({ success: true }),
  _getJson: vi.fn().mockResolvedValue({ data: [] }),
}));
vi.mock('../src/services/telemetry.service', () => ({ capture: vi.fn() }));

const META = AGENT_REGISTRY.claude;
const STREAM_PATH = '/api/commands/pending/stream';
const commandsFrame = (commands: unknown[]): string =>
  `event: commands\ndata: ${JSON.stringify({ commands })}\n\n`;

interface FakeTier {
  base: string;
  /** Every request that hit this tier, `METHOD /path` (query stripped). */
  hits: string[];
  close: () => Promise<void>;
}

async function startTier(
  onStream: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<FakeTier> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url?.split('?')[0]}`);
    if (req.url?.startsWith(STREAM_PATH)) return onStream(req, res);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** A port nothing listens on — the stream host's DNS/origin not being live. */
async function deadBase(): Promise<string> {
  const tier = await startTier(() => undefined);
  await tier.close();
  return tier.base;
}

const sseOk = (res: http.ServerResponse): void => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
};
const status = (code: number) => (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(code);
  res.end();
};

interface RelayUnderTest {
  connectSSE(): void;
  stop(): void;
  sseFailures: number;
  startPollingFallback: () => void;
}

// Fresh module graph (API_BASE + the process-wide stream-host latch are bound
// at import) with the relay driven straight into the SSE path — `start()`
// forces polling under NODE_ENV=test, and the SSE path IS the code under test.
async function relayFor(apiBase: string, streamBase: string, onCmd: (c: unknown) => void) {
  process.env.CODEAM_API_URL = apiBase;
  process.env.CODEAM_STREAM_URL = streamBase;
  vi.resetModules();
  const { CommandRelayService } = await import('../src/services/command-relay.service');
  const relay = new CommandRelayService('plugin-stream-host', onCmd as never, META);
  (relay as unknown as { _running: boolean })._running = true;
  const under = relay as unknown as RelayUnderTest;
  const polling = vi.spyOn(under, 'startPollingFallback');
  return { relay: under, polling };
}

const streamHits = (tier: FakeTier) => tier.hits.filter((h) => h === `GET ${STREAM_PATH}`);

describe('command relay on the stream host (integration, real sockets)', () => {
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
    vi.clearAllMocks();
  });

  it('opens the pending stream on the stream host; ack + heartbeat + agents stay on the api host', async () => {
    let streamRes: http.ServerResponse | null = null;
    const api = await track(startTier(status(404)));
    const stream = await track(
      startTier((_req, res) => {
        sseOk(res);
        streamRes = res;
      }),
    );
    const onCmd = vi.fn();
    const { relay } = await relayFor(api.base, stream.base, onCmd);
    relay.connectSSE();

    await vi.waitFor(() => expect(streamRes).not.toBeNull(), { timeout: 3000 });
    streamRes!.write(commandsFrame([{ id: 'c1', type: 'start_task', payload: {} }]));
    await vi.waitFor(() => expect(onCmd).toHaveBeenCalledTimes(1), { timeout: 3000 });

    expect(streamHits(stream)).toHaveLength(1);
    expect(streamHits(api)).toHaveLength(0);
    // REST stays on API_BASE — the ack for c1 and the goodbye heartbeat.
    expect(pairing._postJson).toHaveBeenCalledWith(
      `${api.base}/api/commands/ack`,
      expect.objectContaining({ commandIds: ['c1'] }),
      expect.anything(),
    );
    relay.stop();
    await vi.waitFor(() =>
      expect(pairing._postJson).toHaveBeenCalledWith(
        `${api.base}/api/plugin/heartbeat`,
        expect.objectContaining({ online: false }),
      ),
    );
    for (const [url] of (pairing._postJson as ReturnType<typeof vi.fn>).mock.calls) {
      expect(String(url).startsWith(api.base)).toBe(true);
    }
  });

  it('5xx from the stream host before any byte → one immediate retry on the api host, no polling', async () => {
    let apiStreamRes: http.ServerResponse | null = null;
    const stream = await track(startTier(status(525)));
    const api = await track(
      startTier((_req, res) => {
        sseOk(res);
        apiStreamRes = res;
      }),
    );
    const onCmd = vi.fn();
    const { relay, polling } = await relayFor(api.base, stream.base, onCmd);
    relay.connectSSE();

    await vi.waitFor(() => expect(apiStreamRes).not.toBeNull(), { timeout: 3000 });
    apiStreamRes!.write(commandsFrame([{ id: 'c2', type: 'start_task', payload: {} }]));
    await vi.waitFor(() => expect(onCmd).toHaveBeenCalledTimes(1), { timeout: 3000 });

    expect(streamHits(stream)).toHaveLength(1);
    expect(streamHits(api)).toHaveLength(1);
    expect(polling).not.toHaveBeenCalled();
    // The host fallback is NOT an SSE failure — it must not eat into the
    // 2-failure budget that flips the relay to polling.
    expect(relay.sseFailures).toBe(0);
    expect(telemetry.capture).toHaveBeenCalledTimes(1);
    expect(telemetry.capture).toHaveBeenCalledWith(
      'sse_stream_host_fallback',
      expect.objectContaining({ host: stream.base, reason: 'status_525' }),
    );
    relay.stop();
  });

  it('ordering: stream host unreachable → api host → polling only after the api host fails twice', async () => {
    const dead = await deadBase();
    const api = await track(startTier(status(503)));
    const { relay, polling } = await relayFor(api.base, dead, vi.fn());
    relay.connectSSE();

    // 1st api attempt (immediately after the host fallback) → 503 → failure #1
    await vi.waitFor(() => expect(streamHits(api)).toHaveLength(1), { timeout: 3000 });
    expect(polling).not.toHaveBeenCalled();
    expect(relay.sseFailures).toBe(1);
    expect(telemetry.capture).toHaveBeenCalledWith(
      'sse_stream_host_fallback',
      expect.objectContaining({ host: dead, reason: 'network' }),
    );

    // 2nd api attempt after the normal reconnect backoff → 503 → polling.
    await vi.waitFor(() => expect(polling).toHaveBeenCalledTimes(1), { timeout: 8000 });
    expect(streamHits(api)).toHaveLength(2);
    // ...and the polling fallback itself hits the api host.
    await vi.waitFor(() =>
      expect(pairing._getJson).toHaveBeenCalledWith(
        expect.stringContaining(`${api.base}/api/commands/pending?`),
        expect.anything(),
      ),
    );
    relay.stop();
  });

  it.each([401, 403, 404])(
    '%s from the stream host is a verdict, not an outage: no host fallback, existing SSE semantics',
    async (code) => {
      const stream = await track(startTier(status(code)));
      const api = await track(startTier(status(200)));
      const { relay, polling } = await relayFor(api.base, stream.base, vi.fn());
      // One prior failure so this single verdict crosses the existing
      // 2-failure threshold deterministically (no backoff wait).
      relay.sseFailures = 1;
      relay.connectSSE();

      await vi.waitFor(() => expect(polling).toHaveBeenCalledTimes(1), { timeout: 3000 });
      expect(streamHits(stream)).toHaveLength(1);
      expect(streamHits(api)).toHaveLength(0);
      expect(telemetry.capture).not.toHaveBeenCalledWith(
        'sse_stream_host_fallback',
        expect.anything(),
      );
      relay.stop();
    },
  );

  it('delivered then dropped → reconnects on the stream host, never falls back', async () => {
    const stream = await track(
      startTier((_req, res) => {
        sseOk(res);
        res.write('event: connected\ndata: {}\n\n');
        setTimeout(() => res.end(), 50);
      }),
    );
    const api = await track(startTier(status(200)));
    const { relay, polling } = await relayFor(api.base, stream.base, vi.fn());
    relay.connectSSE();

    await vi.waitFor(() => expect(streamHits(stream).length).toBeGreaterThanOrEqual(2), {
      timeout: 5000,
    });
    expect(streamHits(api)).toHaveLength(0);
    expect(polling).not.toHaveBeenCalled();
    expect(telemetry.capture).not.toHaveBeenCalledWith(
      'sse_stream_host_fallback',
      expect.anything(),
    );
    relay.stop();
  });
});
