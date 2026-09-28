import type { ChildProcess } from 'child_process';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { log } from '../services/logger';
import { fetchNamedPreviewTunnel } from '../services/pairing.service';
import { resolveCloudflared, spawnNamedTunnel } from '../services/preview/cloudflared';
import { activePreviews } from '../services/preview/index';
import { resolveNamedTunnel } from '../services/preview/named-tunnel';
import { awaitTunnelRegistered } from '../services/preview/tunnel-bringup';
import { handleExportRequest } from './export-registry';

const TUNNEL_REGISTER_DEADLINE_MS = 30_000;

export interface ExportTunnelContext {
  sessionId: string;
  pluginId: string;
  pluginAuthToken?: string;
}

interface Standalone {
  server: http.Server;
  tunnel: ChildProcess;
  baseUrl: string;
  users: number;
}

interface PendingSetup {
  promise: Promise<Standalone>;
  cancelled: boolean;
}

/**
 * INVARIANT: never two connectors on one named tunnel (they would
 * load-balance). `standalone` is the one export connector; `pending` is its
 * setup while in flight, shared by concurrent callers and awaited by
 * `stopExportTunnel` so a stop can never be overtaken by a late registration.
 */
let standalone: Standalone | null = null;
let pending: PendingSetup | null = null;

function closeServer(server: http.Server): Promise<void> {
  return new Promise<void>((r) => server.close(() => r()));
}

async function teardown(s: Standalone): Promise<void> {
  s.tunnel.kill('SIGTERM');
  s.server.closeAllConnections?.();
  await closeServer(s.server);
}

/** A handle bound to ONE instance: a stale or repeated release is a no-op. */
function acquire(inst: Standalone): { baseUrl: string; release: () => void } {
  inst.users += 1;
  let released = false;
  return {
    baseUrl: inst.baseUrl,
    release: () => {
      if (released) return;
      released = true;
      if (standalone !== inst) return;
      inst.users -= 1;
      if (inst.users <= 0) {
        standalone = null;
        void teardown(inst);
      }
    },
  };
}

async function setupStandalone(ctx: ExportTunnelContext, rec: PendingSetup): Promise<Standalone> {
  const named = await resolveNamedTunnel(
    { sessionId: ctx.sessionId, pluginId: ctx.pluginId, pluginAuthToken: ctx.pluginAuthToken ?? '' },
    (c) => fetchNamedPreviewTunnel({ pluginId: c.pluginId, pluginAuthToken: c.pluginAuthToken }),
  );
  if (!named || rec.cancelled) throw new Error('EXPORT_TUNNEL_UNAVAILABLE');

  const server = http.createServer((req, res) => {
    if (!handleExportRequest(req, res)) {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  let tunnel: ChildProcess | null = null;
  try {
    const bin = await resolveCloudflared();
    if (rec.cancelled) throw new Error('stopped');
    tunnel = await spawnNamedTunnel(bin, named.token, port);
    const outcome = await awaitTunnelRegistered(tunnel, named.hostname, TUNNEL_REGISTER_DEADLINE_MS);
    if (outcome.kind !== 'registered') throw new Error(`tunnel ${outcome.kind}`);
    // A preview started while we were registering: it owns the tunnel now.
    if (rec.cancelled) throw new Error('stopped');
  } catch (e) {
    log.info('scratch', `export tunnel unavailable (${(e as Error).message})`);
    tunnel?.kill('SIGTERM');
    server.closeAllConnections?.();
    await closeServer(server);
    throw new Error('EXPORT_TUNNEL_UNAVAILABLE');
  }

  const inst: Standalone = { server, tunnel, baseUrl: `https://${named.hostname}`, users: 0 };
  standalone = inst;
  return inst;
}

/**
 * The public base URL an export link can be served from.
 *
 * A running preview whose tunnel points at the inspector proxy already routes
 * `/.codeam/export/*` (the proxy handles it before forwarding), so the export
 * rides that tunnel. A preview holding a tunnel WITHOUT the inspector (kill
 * switch, or the inspector failed to start) cannot serve the route, and a
 * second connector next to it would load-balance — so that is unavailable.
 * With no preview tunnel, a loopback server is started behind the box's NAMED
 * tunnel just for the export; the last `release()` stops it.
 */
export async function ensureExportBaseUrl(
  ctx: ExportTunnelContext,
): Promise<{ baseUrl: string; release: () => void }> {
  const own = activePreviews.get(ctx.sessionId);
  const previews = [...(own ? [own] : []), ...activePreviews.values()];
  const viaInspector = previews.find((p) => p.tunnel && p.inspector && p.url);
  if (viaInspector) {
    return { baseUrl: viaInspector.url.replace(/\/$/, ''), release: () => {} };
  }
  if (previews.some((p) => p.tunnel)) throw new Error('EXPORT_TUNNEL_UNAVAILABLE');

  if (standalone) return acquire(standalone);

  if (!pending) {
    const rec: PendingSetup = { promise: Promise.resolve(null as unknown as Standalone), cancelled: false };
    rec.promise = setupStandalone(ctx, rec).finally(() => {
      if (pending === rec) pending = null;
    });
    pending = rec;
  }
  const rec = pending;
  const inst = await rec.promise;
  if (rec.cancelled || standalone !== inst) throw new Error('EXPORT_TUNNEL_UNAVAILABLE');
  return acquire(inst);
}

/**
 * Stops the standalone export tunnel, if any — including one still being set
 * up, which is awaited and torn down. Idempotent.
 */
export async function stopExportTunnel(): Promise<void> {
  if (pending) {
    pending.cancelled = true;
    await pending.promise.catch(() => undefined);
  }
  if (!standalone) return;
  const s = standalone;
  standalone = null;
  await teardown(s);
}
