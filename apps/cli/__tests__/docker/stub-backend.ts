/**
 * In-test STUB BACKEND for the self-hosted host-agent Docker E2E.
 *
 * Design of record:
 *   docs/superpowers/specs/2026-06-17-self-hosted-execution-plane-design.md
 *   ("Testing → Real Docker integration test")
 *
 * A tiny plain-`node:http` server (no Nest) that implements EXACTLY the
 * endpoints the host-agent + the spawned `codeam pair-auto` child hit, so a
 * real container can run the real scenario end-to-end against it:
 *
 *   POST /api/self-hosted/redeem            → host enrolls; mints controlPluginId
 *   POST /api/self-hosted/heartbeat         → liveness; recorded
 *   POST /api/self-hosted/unseal-agent-auth → stub api_key so the child can spawn
 *   GET  /api/commands/pending/stream       → SSE: emit ONE self_hosted_deploy,
 *                                             then keep-alive pings
 *   POST /api/pairing/claim-auto-token      → the child's pair-auto handshake;
 *                                             returns a minimal valid pairing
 *   POST /api/plugin/heartbeat              → control + child session liveness
 *   POST /api/plugin/agents                 → agents report (200, recorded)
 *   GET  /api/commands/pending              → polling fallback (empty)
 *   POST /api/commands/result               → command acks (200)
 *
 * Everything else returns `{ success: true, data: {} }` so an unexpected
 * call never crashes the agent mid-scenario. The server records every hit so
 * the test can assert the real process tree reached it.
 *
 * Networking: the server binds 0.0.0.0 on an ephemeral port on the HOST. The
 * container reaches it via `host.docker.internal` (added with
 * `--add-host=host.docker.internal:host-gateway` on Linux) — see the test.
 */

import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';

/** One recorded inbound request (method + path + parsed JSON body). */
export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
  at: number;
}

/** The deploy command the stub pushes down the SSE control channel. */
export interface StubDeployCommand {
  deployId: string;
  repoOrPath: string;
  agentId: string;
  sealedAgentAuth: string;
  autoPairToken: string;
}

export interface StubBackendOptions {
  /** Absolute path INSIDE the container the deploy should target. */
  repoOrPath: string;
  /** Public LinkedAgent id the deploy provisions (default: claude_code). */
  agentId?: string;
}

/** A running stub backend + its recorded traffic + lifecycle handle. */
export interface StubBackend {
  /** Port the server listens on (host side). */
  port: number;
  /** Every request the server saw, in arrival order. */
  readonly requests: RecordedRequest[];
  /** True once at least one redeem succeeded. */
  redeemCount(): number;
  /** Count of heartbeats on `/api/self-hosted/heartbeat`. */
  hostHeartbeatCount(): number;
  /** True once the SSE control stream pushed the deploy command. */
  deployPushed(): boolean;
  /** Count of `/api/pairing/claim-auto-token` hits (the child handshake). */
  pairClaimCount(): number;
  /** Count of `/api/self-hosted/unseal-agent-auth` hits. */
  unsealCount(): number;
  /** The controlPluginId minted at redeem (null before the first redeem). */
  controlPluginId(): string | null;
  /** Stop the server + close all open SSE responses. */
  close(): Promise<void>;
}

function jsonOk(res: http.ServerResponse, data: unknown): void {
  const body = JSON.stringify({ success: true, data });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * Start the stub backend on an ephemeral host port. Returns once it is
 * listening. The SSE control stream, on connect with the minted
 * controlPluginId, emits ONE `self_hosted_deploy` command, then keeps the
 * connection alive with `ping` comments (the relay treats any byte as
 * liveness).
 */
export async function startStubBackend(opts: StubBackendOptions): Promise<StubBackend> {
  const requests: RecordedRequest[] = [];
  const openStreams = new Set<http.ServerResponse>();
  const pingTimers = new Set<NodeJS.Timeout>();

  let mintedControlPluginId: string | null = null;
  let redeems = 0;
  let hostHeartbeats = 0;
  let pushedDeploy = false;
  let pairClaims = 0;
  let unseals = 0;

  const agentId = opts.agentId ?? 'claude_code';

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://stub.local');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // The SSE control stream is the only GET that streams; everything else
    // reads a body. Read the body up-front for POSTs so we record it.
    const body = method === 'POST' ? await readBody(req) : undefined;
    requests.push({ method, path, body, at: Date.now() });

    // ── host-agent enrollment ───────────────────────────────────────────
    if (method === 'POST' && path === '/api/self-hosted/redeem') {
      redeems += 1;
      // Mint the control pluginId the host-agent will subscribe to. The host
      // token is the long-lived secret the box seals 0600.
      mintedControlPluginId = `sh-control-${randomUUID()}`;
      jsonOk(res, {
        hostId: `host-${randomUUID()}`,
        hostToken: `htok-${randomUUID()}`,
        controlPluginId: mintedControlPluginId,
      });
      return;
    }

    if (method === 'POST' && path === '/api/self-hosted/heartbeat') {
      hostHeartbeats += 1;
      jsonOk(res, { ok: true });
      return;
    }

    if (method === 'POST' && path === '/api/self-hosted/unseal-agent-auth') {
      unseals += 1;
      // Stub plaintext so the host-agent can provision + spawn the child.
      // `api_key` keeps provisioning file-free (no oauth JSON needed).
      jsonOk(res, { kind: 'api_key', value: 'stub' });
      return;
    }

    // ── control channel (SSE pull) ──────────────────────────────────────
    if (method === 'GET' && path === '/api/commands/pending/stream') {
      const pluginId = url.searchParams.get('pluginId') ?? '';
      // Only the host's control channel gets the deploy command. The child
      // session subscribes on its OWN pluginId — we never push to it.
      const isControl = mintedControlPluginId !== null && pluginId === mintedControlPluginId;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      openStreams.add(res);
      res.on('close', () => openStreams.delete(res));

      if (isControl) {
        const deploy: StubDeployCommand = {
          deployId: `deploy-${randomUUID()}`,
          repoOrPath: opts.repoOrPath,
          agentId,
          // A well-formed sealed envelope so host-client's isSealedEnvelope
          // guard passes (the stub unseal endpoint returns the plaintext).
          sealedAgentAuth: JSON.stringify({
            ciphertext: 'stub',
            iv: 'stub',
            authTag: 'stub',
            keyVersion: 1,
          }),
          autoPairToken: `auto-${randomUUID()}`,
        };
        const frame =
          `event: commands\n` +
          `data: ${JSON.stringify({ commands: [{ id: `cmd-${randomUUID()}`, sessionId: pluginId, type: 'self_hosted_deploy', payload: deploy }] })}\n\n`;
        res.write(frame);
        pushedDeploy = true;
      }

      // Keep-alive ping (the relay counts any byte as liveness). Lightweight
      // comment frame every 2 s.
      const ping = setInterval(() => {
        try {
          res.write(`: ping\n\n`);
        } catch {
          /* socket gone */
        }
      }, 2_000);
      ping.unref?.();
      pingTimers.add(ping);
      res.on('close', () => {
        clearInterval(ping);
        pingTimers.delete(ping);
      });
      return;
    }

    // ── child pair-auto handshake ───────────────────────────────────────
    if (method === 'POST' && path === '/api/pairing/claim-auto-token') {
      pairClaims += 1;
      // Minimal valid pairing so the child's claim() resolves and it chains
      // into the (infra-only, agent-launch-skipped) run loop. `agent` must
      // be a known internal agent id so isKnownAgentId passes.
      jsonOk(res, {
        sessionId: `sess-${randomUUID()}`,
        pluginAuthToken: `pat-${randomUUID()}`,
        agent: 'claude',
        user: { name: 'Docker E2E', email: 'e2e@example.com', plan: 'pro' },
      });
      return;
    }

    // ── session liveness / misc (always 200 so the agent never crashes) ──
    if (method === 'POST' && path === '/api/plugin/heartbeat') {
      jsonOk(res, { ok: true });
      return;
    }
    if (method === 'POST' && path === '/api/plugin/agents') {
      jsonOk(res, { ok: true });
      return;
    }
    if (method === 'GET' && path === '/api/commands/pending') {
      // Polling fallback — keep it empty; the control channel is SSE.
      jsonOk(res, []);
      return;
    }

    // Catch-all: never 404 mid-scenario — any unforeseen call the agent
    // makes (e.g. telemetry, ai-result) gets a benign success.
    jsonOk(res, {});
  }

  await new Promise<void>((resolve) => {
    server.listen(0, '0.0.0.0', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    requests,
    redeemCount: () => redeems,
    hostHeartbeatCount: () => hostHeartbeats,
    deployPushed: () => pushedDeploy,
    pairClaimCount: () => pairClaims,
    unsealCount: () => unseals,
    controlPluginId: () => mintedControlPluginId,
    close: async () => {
      for (const t of pingTimers) clearInterval(t);
      pingTimers.clear();
      for (const stream of openStreams) {
        try {
          stream.end();
        } catch {
          /* already closed */
        }
      }
      openStreams.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
