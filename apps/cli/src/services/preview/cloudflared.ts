import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import which from 'which';

const CACHED_BINARY = path.join(os.homedir(), '.codeam', 'bin', 'cloudflared');

/**
 * Poll a Cloudflare Quick Tunnel URL until it returns ANY response
 * (status < 500). cloudflared prints its URL the moment the local
 * connector is up, but the public `*.trycloudflare.com` hostname
 * needs ~3–10 s for DNS to propagate to the user's device — the
 * mobile WebView otherwise hits NSURLErrorDomain -1003 ("hostname
 * could not be found") on first load. Probing from the CLI host
 * before emitting `preview_ready` shifts that wait to the loading
 * state, which is the right surface for it.
 *
 * On `ENOTFOUND` / network-blip errors we keep retrying inside the
 * deadline — those are exactly the propagation transients we're
 * trying to absorb.
 */
export async function waitForCloudflaredReady(
  url: string,
  timeoutMs = 30_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.status < 500) return;
    } catch {
      // DNS not propagated yet / TLS handshake racing / generic
      // network blip — retry inside the deadline.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Tunnel URL ${url} not reachable after ${timeoutMs}ms (DNS may still be propagating).`,
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
