/**
 * SSE subscriber for pair-flow completion.
 *
 * Replaces the old `pollStatus` exponential-backoff polling loop
 * (QA Android #285 + memory: feedback_no_polling_anywhere). Backend's
 * `pair()` service publishes a synthetic `pair_completed` command on
 * the existing `/api/commands/pending/stream?pluginId=X` channel the
 * moment the mobile claims the code; this subscriber listens for it
 * and resolves the pair flow without any polling on the wire.
 *
 * Reuses the existing pending-stream endpoint (no auth — keyed by
 * pluginId only) and the existing command shape. The only new
 * vocabulary is the `pair_completed` command type, which carries the
 * same `PairedUserInfo` shape `pollStatus` used to surface so the
 * caller's onPaired handler doesn't change.
 *
 * The endpoint lives on the STREAM tier, so it is opened against
 * `streamHost.current` with the same one-time api-host fallback the
 * relay uses (network error or 5xx before any byte; never on an
 * auth/404 verdict) — see `stream-base-url.ts`. Pairing is the first
 * stream the process opens, so a fallback taken here is inherited by
 * the relay that follows.
 *
 * Pre-pair the CLI has no pluginAuthToken; we don't send one. The
 * pending-stream controller doesn't enforce auth at the route level
 * (verified in apps/api-v2/src/commands/pending-stream.controller.ts).
 *
 * Reconnect on transient network failures is handled by the same
 * long-poll style the chat-output / commands-pending streams use —
 * Vercel/Cloud Run idle-close the SSE every ~25 s and we re-open
 * immediately. The 5 min wall-clock timeout matches the legacy
 * `pollStatus` ceiling so user-visible behaviour is unchanged on the
 * give-up path.
 */
import * as https from 'node:https';
import * as http from 'node:http';
import { log } from './logger';
import { vercelBypassHeader } from '../lib/backend-headers';
import type { PairedUserInfo } from './pairing.service';
import { describeStreamHostFailure, streamHost, type StreamHostFailure } from './stream-base-url';

const PENDING_STREAM_PATH = '/api/commands/pending/stream';
const PAIR_TIMEOUT_MS = 5 * 60 * 1000;

interface RawCommand {
  id: string;
  type: string;
  pluginId: string;
  sessionId: string;
  payload?: Record<string, unknown>;
}

/**
 * Test seam — production code routes through real https.
 * `_pairCompletionTestSeam.feedCommand(cmd)` lets vitest specs drive
 * the dispatcher without spinning up a network listener.
 */
const dispatchers = new Set<(cmd: RawCommand) => void>();

export const _pairCompletionTestSeam = {
  feedCommand(cmd: RawCommand): void {
    for (const fn of dispatchers) fn(cmd);
  },
};

export function subscribeToPairCompletion(
  pluginId: string,
  onPaired: (info: PairedUserInfo) => void,
  onTimeout: () => void,
  // SEC crit1 (#8): the pollSecret generated for this pairing. The
  // backend stores its hash at /pairing/code, so this pre-pair
  // subscription passes the command-endpoint gate when enforced.
  pollSecret?: string,
): () => void {
  let stopped = false;
  let req: http.ClientRequest | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;

  const dispatch = (cmd: RawCommand): void => {
    if (stopped) return;
    if (cmd.pluginId !== pluginId) return;
    if (cmd.type !== 'pair_completed') return;
    const payload = (cmd.payload ?? {}) as Record<string, unknown>;
    const info: PairedUserInfo = {
      sessionId:
        typeof payload.sessionId === 'string' ? payload.sessionId : cmd.sessionId,
      userId: typeof payload.userId === 'string' ? payload.userId : undefined,
      userName: typeof payload.userName === 'string' ? payload.userName : '',
      userEmail: typeof payload.userEmail === 'string' ? payload.userEmail : '',
      plan: typeof payload.plan === 'string' ? payload.plan : 'FREE',
      pluginAuthToken:
        typeof payload.pluginAuthToken === 'string'
          ? payload.pluginAuthToken
          : undefined,
    };
    stop();
    onPaired(info);
  };

  dispatchers.add(dispatch);

  // Stream-host → api-host fallback. True exactly once per process, on the
  // failure that moved it; the caller then reconnects immediately instead
  // of waiting out its reconnect delay.
  const fallBackToApiHost = (failure: StreamHostFailure, delivered: boolean): boolean => {
    const host = streamHost.current;
    if (!streamHost.fallBackToApiHost(failure, delivered)) return false;
    log.debug(
      'pairSubscribe',
      `sse stream host ${host} failed (${describeStreamHostFailure(failure)}) — using api host`,
    );
    return true;
  };

  // Open the SSE connection. The pending-stream endpoint emits
  // `connected` immediately on subscribe and then `commands` events
  // for each Redis publish — exactly what we need.
  const connect = (): void => {
    if (stopped) return;
    const url = new URL(`${streamHost.current}${PENDING_STREAM_PATH}`);
    url.searchParams.set('pluginId', pluginId);
    const transport = url.protocol === 'https:' ? https : http;
    let delivered = false;
    req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          ...vercelBypassHeader(),
          ...(pollSecret ? { 'X-Plugin-Poll-Secret': pollSecret } : {}),
        },
        timeout: 35_000,
      },
      (res) => {
        if (res.statusCode !== 200) {
          log.trace(
            'pairSubscribe',
            `sse status=${res.statusCode}; will reconnect in 1s`,
          );
          res.resume();
          if (fallBackToApiHost({ kind: 'status', status: res.statusCode ?? 0 }, delivered)) {
            connect();
            return;
          }
          setTimeout(connect, 1000);
          return;
        }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          delivered = true;
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            parseFrame(frame, dispatch);
          }
        });
        res.on('end', () => {
          if (!stopped) setTimeout(connect, 250);
        });
        res.on('error', () => {
          if (stopped) return;
          if (fallBackToApiHost({ kind: 'network' }, delivered)) connect();
          else setTimeout(connect, 1000);
        });
      },
    );
    req.on('error', () => {
      // `stop()` destroys the request too — a teardown must never latch the
      // process onto the api host.
      if (stopped) return;
      if (fallBackToApiHost({ kind: 'network' }, delivered)) connect();
      else setTimeout(connect, 1000);
    });
    req.on('timeout', () => {
      req?.destroy();
      if (!stopped) setTimeout(connect, 250);
    });
    req.end();
  };

  connect();

  timeoutTimer = setTimeout(() => {
    stop();
    onTimeout();
  }, PAIR_TIMEOUT_MS);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    dispatchers.delete(dispatch);
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    if (req) {
      req.destroy();
      req = null;
    }
  }

  return stop;
}

function parseFrame(
  frame: string,
  dispatch: (cmd: RawCommand) => void,
): void {
  let eventType = 'message';
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) eventType = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trimStart();
  }
  if (eventType !== 'commands') return;
  try {
    const parsed = JSON.parse(data) as { commands?: RawCommand[] };
    if (!Array.isArray(parsed.commands)) return;
    for (const cmd of parsed.commands) dispatch(cmd);
  } catch {
    // Malformed frame — ignore, we'll get the next one.
  }
}
