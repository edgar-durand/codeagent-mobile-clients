import { isPortListening } from './port-ready';

/**
 * Where the dev server ACTUALLY listens — the address the inspector proxy (and
 * so the tunnel) must forward to.
 *
 * ⚠️ WHY (QA CodeAgent Box, 2026-09-25): the detection is the agent's GUESS at
 * the port. It said 5173 for a Vite app whose `vite.config.ts` pins
 * `server.port: 5174`, and Vite bound only `[::1]`. The proxy forwarded to
 * `127.0.0.1:5173`, where nothing listens, so the public URL answered
 * Cloudflare's 502 while the dev server was perfectly healthy.
 *
 * The dev server itself says where it listens (`Local: http://localhost:5174/`
 * — Vite, Next, Nuxt, Astro, SvelteKit, CRA all print a line like it), so that
 * is the first candidate. The detection's port comes second, and every
 * candidate is confirmed on both loopbacks: `localhost` resolves to `::1`
 * first on current Node, so many servers bind IPv6 only.
 */
export interface ServedAddress {
  host: string;
  port: number;
}

const LOOPBACK_HOSTS = ['127.0.0.1', '::1'] as const;

// Strip ANSI colour codes — Vite prints `Local:` and the URL in different colours.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const LOCAL_URL_RE =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\]):(\d{2,5})\b/gi;

/**
 * Ports the dev server announced for its LOCAL URL, most recent first. Only
 * loopback / wildcard hosts count: a `Network:` URL on the LAN IP names the
 * same port, and an unrelated remote URL (an API proxy target) must not.
 */
export function announcedPorts(output: string): number[] {
  const clean = output.replace(ANSI_RE, '');
  const ports: number[] = [];
  for (const m of clean.matchAll(LOCAL_URL_RE)) {
    const port = Number(m[1]);
    if (port > 0 && port < 65536) ports.push(port);
  }
  return [...new Set(ports.reverse())];
}

export interface ResolveServedAddressDeps {
  listening?: (port: number, host: string) => Promise<boolean>;
}

/**
 * The first candidate that is really accepting connections. Falls back to the
 * detection's port on IPv4 — exactly the old behaviour — when nothing answers,
 * so this can never make a working preview worse.
 */
export async function resolveServedAddress(
  output: string,
  detectedPort: number,
  deps: ResolveServedAddressDeps = {},
): Promise<ServedAddress> {
  const listening = deps.listening ?? isPortListening;
  const candidates = [...new Set([...announcedPorts(output), detectedPort])];
  for (const port of candidates) {
    for (const host of LOOPBACK_HOSTS) {
      if (await listening(port, host)) return { host, port };
    }
  }
  return { host: '127.0.0.1', port: detectedPort };
}
