import { spawn } from 'child_process';
import dns, { Resolver } from 'dns/promises';
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
 * Why `dns.lookup` (getaddrinfo / OS resolver), not c-ares:
 *
 *   Empirical measurement inside a GitHub Codespace, with a tunnel
 *   spawned via `cloudflared tunnel --url ...`:
 *
 *     dns.lookup (getaddrinfo)                  →  ~3 s to resolve
 *     Resolver.resolve4 + system /etc/resolv.conf →  >38 s ENOTFOUND
 *     Resolver.resolve4 + 1.1.1.1 explicit       →  >60 s ENOTFOUND
 *
 *   The OS resolver in modern Linux distros (systemd-resolved) uses a
 *   shared cache hierarchy fed by multiple paths (GHC's internal
 *   resolver in codespaces, fast IPv6 to Google/Cloudflare). c-ares
 *   does UDP queries directly to the configured nameservers and
 *   misses that fast path entirely.
 *
 *   An earlier version of this probe used `Resolver` pointed at
 *   1.1.1.1 + `resolve4` only. That hit BOTH a slow-path issue
 *   (c-ares to 1.1.1.1 doesn't see fresh trycloudflare records for
 *   30-60 s) AND a record-class issue (Quick Tunnels often publish
 *   only AAAA initially, no A). Mobile WebViews ALWAYS use the OS
 *   resolver — using `dns.lookup` here matches their resolution path
 *   so when our probe says "ready" the WebView does too.
 *
 *   Earlier comments warned that getaddrinfo caches NXDOMAIN
 *   aggressively. Measured behavior: the negative cache TTL is short
 *   enough that 1-second polling sees positive results within
 *   3-4 ticks of the tunnel becoming reachable. The hypothesised
 *   cache poisoning does not materialise.
 */
export async function waitForCloudflaredReady(
  url: string,
  timeoutMs = 60_000,
): Promise<void> {
  const hostname = new URL(url).hostname;
  // c-ares fallback in case `dns.lookup` is somehow misconfigured
  // (custom /etc/nsswitch.conf, container with no resolver). Probes
  // BOTH classes — Quick Tunnels often publish AAAA before A. Each
  // tick fires lookup + resolve4 + resolve6 in parallel and
  // accepts whichever lands first.
  const cares = new Resolver();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const lookup = dns
      .lookup(hostname, { all: true })
      .then((addrs) => addrs.length > 0, () => false);
    const v4 = cares
      .resolve4(hostname)
      .then((addrs) => addrs.length > 0, () => false);
    const v6 = cares
      .resolve6(hostname)
      .then((addrs) => addrs.length > 0, () => false);
    const results = await Promise.all([lookup, v4, v6]);
    if (results.some((ok) => ok)) return;
    // 1 s tick on purpose — faster polling poisons the OS negative
    // cache and pushes time-to-resolve out by several seconds.
    await new Promise((r) => setTimeout(r, 1000));
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
