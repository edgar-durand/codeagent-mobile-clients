import { log } from '../logger';
import { parseCloudflaredUrl } from './parser';

/**
 * cloudflared logs "Registered tunnel connection" once the edge has
 * accepted the connector — the AUTHORITATIVE "tunnel is live" signal.
 * We gate on this instead of resolving the hostname from THIS host: a
 * self-hosted box's resolver (e.g. Docker's embedded 127.0.0.11) can
 * take >40 s to see a fresh trycloudflare record even though the
 * tunnel registered fine and is reachable from the internet — that
 * false-negative failed every self-hosted preview (verified live:
 * 3/3 retries registered, DNS poll timed out).
 */
const TUNNEL_REGISTERED_RE = /Registered tunnel connection/i;

/**
 * Minimal surface of a spawned cloudflared child that
 * {@link awaitTunnelRegistered} watches. Structural subset of
 * `ChildProcess` so tests can hand in an EventEmitter-backed stub.
 */
export interface TunnelCandidateIO {
  readonly exitCode?: number | null;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export type TunnelRegistrationOutcome =
  /** Edge accepted the connector (and, for quick tunnels, the public URL was parsed). */
  | { kind: 'registered'; url: string }
  /** Deadline elapsed. `sawUrl` picks the caller's error message. */
  | { kind: 'timeout'; sawUrl: boolean }
  /** cloudflared died before registering — no point waiting out the deadline. */
  | { kind: 'exited'; sawUrl: boolean; code: number | null };

/**
 * Wait — EVENT-DRIVEN, no polling — for a freshly-spawned cloudflared
 * child to register with the Cloudflare edge. ONE implementation for
 * both tunnel flavours:
 *
 * - **Named tunnel** (`hostname` given): the public URL is known up
 *   front (`https://<hostname>`); success requires only the
 *   "Registered tunnel connection" log line.
 * - **Quick tunnel** (`hostname === null`): success requires BOTH the
 *   `https://*.trycloudflare.com` URL parsed from output AND the
 *   registered-connection line.
 *
 * We do NOT DNS-probe from here — once registered, the edge serves the
 * URL and the mobile WebView rides out its own DNS-propagation window
 * (it no longer caches NXDOMAIN and gives up — see PreviewWebView's
 * retry).
 *
 * The promise resolves straight from the stdout/stderr `data` handlers
 * (or the child's `exit` event), raced against a single `setTimeout`
 * deadline — per the repo's no-polling rule there is no
 * `setInterval`/sleep loop re-checking flags. Every listener is scoped
 * to an AbortController and detached in `finally`, so a retried attempt
 * never leaks handlers onto a dead child's streams.
 *
 * Every non-empty output chunk is logged under `[preview]`
 * (`cloudflared: …`) so tunnel issues stay post-hoc debuggable without
 * re-running.
 */
export async function awaitTunnelRegistered(
  candidate: TunnelCandidateIO,
  hostname: string | null,
  deadlineMs: number,
): Promise<TunnelRegistrationOutcome> {
  let url: string | null = hostname ? `https://${hostname}` : null;
  let registered = false;

  // Child already dead (spawn failure, bad credentials file, …) — its
  // 'exit' event has fired and will never fire again, so waiting out
  // the deadline would be pure dead time before the caller's retry.
  if (candidate.exitCode != null) {
    return { kind: 'exited', sawUrl: url != null, code: candidate.exitCode };
  }

  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  /** Attach now, detach when `ac` aborts — scopes every listener to this attempt. */
  const scoped = (attach: () => void, detach: () => void): void => {
    attach();
    ac.signal.addEventListener('abort', detach, { once: true });
  };

  try {
    return await new Promise<TunnelRegistrationOutcome>((resolve) => {
      const onChunk = (chunk: Buffer): void => {
        const s = chunk.toString();
        if (!url) url = parseCloudflaredUrl(s);
        if (TUNNEL_REGISTERED_RE.test(s)) registered = true;
        const trimmed = s.replace(/\n+$/g, '');
        if (trimmed.length > 0) log.info('preview', `cloudflared: ${trimmed}`);
        if (url && registered) resolve({ kind: 'registered', url });
      };
      const onExit = (code: number | null): void => {
        resolve({ kind: 'exited', sawUrl: url != null, code });
      };
      const { stdout, stderr } = candidate;
      if (stdout) scoped(() => stdout.on('data', onChunk), () => stdout.off('data', onChunk));
      if (stderr) scoped(() => stderr.on('data', onChunk), () => stderr.off('data', onChunk));
      scoped(() => candidate.on('exit', onExit), () => candidate.off('exit', onExit));
      timer = setTimeout(() => resolve({ kind: 'timeout', sawUrl: url != null }), deadlineMs);
    });
  } finally {
    ac.abort();
    if (timer) clearTimeout(timer);
  }
}
