import * as net from 'net';

/**
 * Resolve true once *something* is accepting TCP connections on
 * `127.0.0.1:<port>`, or false if nothing is listening before the
 * deadline.
 *
 * This is the additive fallback for preview ready-detection. The
 * primary signal is the agent-supplied `ready_pattern` regex against
 * the dev server's stdout, but that pattern is brittle: Next.js, for
 * instance, prints `▲ Next.js 14.x` and `- Local: http://localhost:3000`
 * rather than a literal "ready" line, so a slightly-off pattern stalls
 * the whole pipeline at WAITING_FOR_READY for the full 120 s while the
 * server is happily listening. "Port is accepting connections" is a
 * framework-agnostic readiness signal that catches those misses.
 *
 * Uses a one-shot TCP connect per poll (not an HTTP request) so it
 * never cares about the protocol the server speaks (h1/h2), redirects,
 * or auth gateways — a successful `connect` means the socket is bound
 * and ready, which is exactly the "did it start listening" question.
 */
export function isPortListening(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    // Short per-attempt timeout so a black-holed connect doesn't hold
    // the poll open longer than the poll interval.
    socket.setTimeout(1_000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

export async function waitForPortListening(
  port: number,
  opts: { timeoutMs: number; intervalMs?: number },
): Promise<boolean> {
  const interval = opts.intervalMs ?? 500;
  const deadline = Date.now() + opts.timeoutMs;
  // Poll, not a one-shot — the server may bind a beat after spawn.
  // This is a bring-up gate, not a steady-state watcher, so a bounded
  // poll loop is the right primitive (and there's no event stream to
  // hang it off — the socket isn't open yet, by definition).
  for (;;) {
    if (await isPortListening(port)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, interval));
  }
}
