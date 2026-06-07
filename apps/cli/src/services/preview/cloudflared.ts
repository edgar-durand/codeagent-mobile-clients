import { spawn } from 'child_process';
import { Resolver } from 'dns/promises';
import { createWriteStream } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import which from 'which';

const CACHED_BINARY = path.join(os.homedir(), '.codeam', 'bin', 'cloudflared');

/**
 * Block until a Cloudflare Quick Tunnel URL is DNS-resolvable.
 * cloudflared prints its URL the moment its local connector is up,
 * but the public `*.trycloudflare.com` hostname needs a few seconds
 * for DNS to propagate. If the mobile WebView opens the URL during
 * that window it gets NXDOMAIN and caches the negative result —
 * `webview.reload()` does NOT bypass the cache, so a "server IP
 * could not be found" page persists until the user fully tears the
 * preview down and reopens it. Blocking `preview_ready` on DNS
 * resolution gives the WebView a non-poisoned first load.
 *
 * Why c-ares + Cloudflare's 1.1.1.1 (not `dns.lookup` or `fetch`):
 *
 *   1. `dns.lookup` calls the OS resolver (`getaddrinfo`), which
 *      caches NEGATIVE responses for its own TTL. Polling rapidly
 *      during the propagation window poisons the OS cache with
 *      NXDOMAIN — the lookup keeps returning ENOTFOUND for many
 *      seconds even after DNS has actually propagated.
 *   2. `fetch` (undici) doesn't speak HTTP/2, and `*.trycloudflare.com`
 *      serves h2 via ALPN with no h1 fallback path. A HEAD probe
 *      times out 100% of the time even when the tunnel is reachable
 *      from curl / WebViews.
 *   3. `dns.resolve` over c-ares directly hits UDP — no OS cache
 *      involvement — and pointing it at `1.1.1.1` (Cloudflare,
 *      authoritative for `trycloudflare.com`) gives us the earliest
 *      possible positive signal for a freshly-registered tunnel.
 *
 * IMPORTANT: trycloudflare.com Quick Tunnel hostnames frequently
 * publish ONLY AAAA (IPv6) records — no A (IPv4). An earlier version
 * of this probe used `resolver.resolve4` only and timed out 100% of
 * the time when the tunnel was actually reachable, because the
 * record class we were asking for never existed. Probe BOTH A and
 * AAAA in parallel and accept whichever lands first.
 */
export async function waitForCloudflaredReady(
  url: string,
  timeoutMs = 60_000,
): Promise<void> {
  const hostname = new URL(url).hostname;
  const resolver = new Resolver();
  resolver.setServers(['1.1.1.1', '1.0.0.1']);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v4 = resolver.resolve4(hostname).then(
      (addrs) => addrs.length > 0,
      () => false,
    );
    const v6 = resolver.resolve6(hostname).then(
      (addrs) => addrs.length > 0,
      () => false,
    );
    const [ok4, ok6] = await Promise.all([v4, v6]);
    if (ok4 || ok6) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `DNS for ${hostname} did not resolve within ${timeoutMs}ms (Cloudflare Quick Tunnel registration may have failed).`,
  );
}

interface Options {
  /** Skip the GitHub Releases download. Used in tests + offline pre-flight. */
  skipDownload?: boolean;
}

/**
 * Resolve a path to the cloudflared binary. Lookup order:
 *
 *   1. `$PATH` (Homebrew / scoop / system install)
 *   2. The CLI's own cache at `~/.codeam/bin/cloudflared` (from a
 *      previous auto-install on this machine)
 *   3. Download the static binary from cloudflare/cloudflared's
 *      latest GitHub release into the cache and return that path
 *
 * Throws when steps 1–3 all fail (corporate proxy, antivirus
 * quarantine). The error message is what the mobile / landing error
 * card renders verbatim, so it MUST be human-actionable.
 */
export async function resolveCloudflared(opts: Options = {}): Promise<string> {
  try {
    return await which('cloudflared');
  } catch {
    // fallthrough
  }

  try {
    await fs.access(CACHED_BINARY);
    return CACHED_BINARY;
  } catch {
    // fallthrough
  }

  if (opts.skipDownload) {
    throw new Error(
      'cloudflared not installed. Install via `brew install cloudflared` (macOS) or download from https://github.com/cloudflare/cloudflared/releases.',
    );
  }

  await downloadCloudflared(CACHED_BINARY);
  return CACHED_BINARY;
}

async function downloadCloudflared(target: string): Promise<void> {
  const url = downloadUrlForPlatform();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to download cloudflared from ${url}: HTTP ${response.status}. Install manually from https://github.com/cloudflare/cloudflared/releases.`,
    );
  }
  await pipeline(
    response.body as unknown as NodeJS.ReadableStream,
    createWriteStream(target, { mode: 0o755 }),
  );
}

function downloadUrlForPlatform(): string {
  const platform = process.platform;
  const arch = process.arch;
  const base = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
  if (platform === 'darwin' && arch === 'arm64') return `${base}/cloudflared-darwin-arm64.tgz`;
  if (platform === 'darwin' && arch === 'x64') return `${base}/cloudflared-darwin-amd64.tgz`;
  if (platform === 'linux' && arch === 'x64') return `${base}/cloudflared-linux-amd64`;
  if (platform === 'linux' && arch === 'arm64') return `${base}/cloudflared-linux-arm64`;
  if (platform === 'win32') return `${base}/cloudflared-windows-amd64.exe`;
  throw new Error(
    `cloudflared auto-install not supported on ${platform}/${arch}. Install manually from https://github.com/cloudflare/cloudflared/releases.`,
  );
}

/**
 * Spawn `cloudflared tunnel --url http://localhost:<port>` and resolve
 * with the running child. The caller watches stderr for the
 * `https://*.trycloudflare.com` URL via {@link parseCloudflaredUrl}.
 */
export function spawnCloudflaredTunnel(bin: string, port: number): ReturnType<typeof spawn> {
  return spawn(bin, ['tunnel', '--url', `http://localhost:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
