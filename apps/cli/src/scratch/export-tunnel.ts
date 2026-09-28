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

/** The standalone export server + its named-tunnel connector, when no preview carries the route. */
let standalone: { server: http.Server; tunnel: ChildProcess; baseUrl: string; users: number } | null =
  null;

function closeServer(server: http.Server): Promise<void> {
  return new Promise<void>((r) => server.close(() => r()));
}

/**
 * The public base URL an export link can be served from.
 *
 * A running preview whose tunnel points at the inspector proxy already routes
 * `/.codeam/export/*` (the proxy handles it before forwarding), so the export
 * rides that tunnel. Otherwise a loopback server is started behind the box's
 * NAMED tunnel just for the export; `release()` stops it.
 */
export async function ensureExportBaseUrl(
  ctx: ExportTunnelContext,
): Promise<{ baseUrl: string; release: () => void }> {
  const preview = activePreviews.get(ctx.sessionId);
  if (preview?.tunnel && preview.inspector && preview.url) {
    return { baseUrl: preview.url.replace(/\/$/, ''), release: () => {} };
  }

  const release = (): void => {
    if (!standalone) return;
    standalone.users -= 1;
    if (standalone.users <= 0) void stopExportTunnel();
  };

  // A second export while the first is still downloading shares the connector:
  // two connectors on one named tunnel would load-balance between them.
  if (standalone) {
    standalone.users += 1;
    return { baseUrl: standalone.baseUrl, release };
  }

  const named = await resolveNamedTunnel(
    { sessionId: ctx.sessionId, pluginId: ctx.pluginId, pluginAuthToken: ctx.pluginAuthToken ?? '' },
    (c) => fetchNamedPreviewTunnel({ pluginId: c.pluginId, pluginAuthToken: c.pluginAuthToken }),
  );
  if (!named) throw new Error('EXPORT_TUNNEL_UNAVAILABLE');

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
    tunnel = await spawnNamedTunnel(bin, named.token, port);
    const outcome = await awaitTunnelRegistered(tunnel, named.hostname, TUNNEL_REGISTER_DEADLINE_MS);
    if (outcome.kind !== 'registered') throw new Error(`tunnel ${outcome.kind}`);
  } catch (e) {
    log.info('scratch', `export tunnel unavailable (${(e as Error).message})`);
    tunnel?.kill('SIGTERM');
    await closeServer(server);
    throw new Error('EXPORT_TUNNEL_UNAVAILABLE');
  }

  const baseUrl = `https://${named.hostname}`;
  standalone = { server, tunnel, baseUrl, users: 1 };
  return { baseUrl, release };
}

/** Stops the standalone export tunnel, if any. Idempotent. */
export async function stopExportTunnel(): Promise<void> {
  if (!standalone) return;
  const s = standalone;
  standalone = null;
  s.tunnel.kill('SIGTERM');
  s.server.closeAllConnections?.();
  await closeServer(s.server);
}
