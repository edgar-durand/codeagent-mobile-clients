import * as http from 'http';
import * as path from 'path';

/**
 * Expo previews ride OUR cloudflared tunnel — never Expo's ngrok one.
 *
 * ⚠️ WHY (2026-09-07, confirmed on a clean box container). `expo start
 * --tunnel` authenticates ngrok with the token hardcoded in `@expo/cli`
 * (`AsyncNgrok` → `NGROK_CONFIG.authToken`), ONE account shared by every
 * anonymous Expo user in the world. Whenever that account sits at its cap the
 * ngrok agent logs `Your account is limited to 5000 simultaneous ngrok agent
 * sessions (ERR_NGROK_108)` and exits; `@expo/ngrok` then throws `Cannot read
 * properties of undefined (reading 'body')` (its error handler reads
 * `error.response.body` when the agent API never answered), Expo exits 1 and
 * the preview dies with `ERR_SPAWN_FAILED "dev server exited (code 1)"`. It
 * works whenever the shared account dips under the cap — which a user (Rafael,
 * 2026-09-07: 14:22 ok / 14:59 fail / 15:02 fail / 15:05 ok / 15:05 fail)
 * experienced as "start after stop breaks". Nothing in our stop/start sequence
 * caused it.
 *
 * The replacement, validated end-to-end in the container:
 *   1. bring up cloudflared → `http://127.0.0.1:<port>` FIRST (it happily
 *      fronts a port that isn't listening yet — 502 until Metro binds);
 *   2. spawn Expo WITHOUT `--tunnel`, with `--port <port>` and
 *      `EXPO_PACKAGER_PROXY_URL=https://<tunnel-host>` in its env.
 *      `@expo/cli`'s `UrlCreator.getUrlComponents` honours it ("Proxy comes
 *      first"): the manifest advertises `hostUri = <tunnel-host>` and
 *      `bundleUrl = https://<tunnel-host>/index.bundle?…`. ⚠️ Expo reads that
 *      variable from the process env at startup, so the tunnel MUST exist
 *      before Expo spawns — the opposite of the non-Expo bring-up order.
 *   3. hand the app `exps://<tunnel-host>` — Expo Go maps `exps://` → `https://`.
 */

/** The env var `@expo/cli` reads for a public URL that fronts Metro. */
export const EXPO_PACKAGER_PROXY_URL_ENV = 'EXPO_PACKAGER_PROXY_URL';

/**
 * Drop `--tunnel` / `--tunnel=<v>` from an Expo command's args. Older
 * detections and saved `.codeam/preview.json` files still carry it (it WAS
 * our recipe); left in, Expo would start ngrok and we'd be back to the shared
 * account. `--lan` / `--localhost` are harmless (the proxy URL wins) and stay.
 */
export function stripExpoTunnelFlag(args: readonly string[]): string[] {
  return args.filter((a) => a !== '--tunnel' && !a.startsWith('--tunnel='));
}

/**
 * Make sure Metro binds the port our tunnel points at. An explicit `--port`
 * (either form) in the detection is respected; otherwise `--port <port>` is
 * appended — through an `npm run … --` separator when the script runs via npm,
 * which otherwise swallows flags meant for the script (yarn/pnpm/bun forward
 * trailing args implicitly; pnpm/bun were already rewritten to npm upstream).
 */
export function ensureExpoPortArg(
  command: string,
  args: readonly string[],
  port: number,
): string[] {
  const hasPort = args.some((a) => a === '--port' || a.startsWith('--port='));
  if (hasPort) return [...args];
  const out = [...args];
  if (path.basename(command) === 'npm' && !out.includes('--')) out.push('--');
  out.push('--port', String(port));
  return out;
}

/** The args an Expo dev server is spawned with: no `--tunnel`, port pinned. */
export function expoSpawnArgs(command: string, args: readonly string[], port: number): string[] {
  return ensureExpoPortArg(command, stripExpoTunnelFlag(args), port);
}

/**
 * The deep link Expo Go opens for a manifest served over https:
 * `https://<host>` → `exps://<host>`. No port — the tunnel is on 443.
 */
export function expoGoDeepLink(publicUrl: string): string {
  return `exps://${new URL(publicUrl).host}`;
}

/**
 * One-shot: does Metro on `port` serve the Expo manifest? Asks exactly like
 * Expo Go does — `GET /` with `expo-platform: ios` — because without that
 * header Metro answers the dev-launcher HTML, which says nothing about whether
 * the manifest middleware is up. Any 2xx counts; connection refused, a timeout
 * and a non-2xx (Metro still booting answers 5xx) are all `false`.
 */
export function isExpoManifestServed(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host, port, path: '/', headers: { 'expo-platform': 'ios' }, timeout: 1_500 },
      (res) => {
        const ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300;
        res.resume();
        resolve(ok);
      },
    );
    req.once('timeout', () => req.destroy());
    req.once('error', () => resolve(false));
  });
}

/**
 * Poll {@link isExpoManifestServed} until it answers true or the deadline
 * passes. Same shape as `waitForPortListening` — a bring-up gate, not a
 * steady-state watcher, so a bounded poll is the right primitive.
 */
export async function waitForExpoManifest(
  port: number,
  opts: { timeoutMs: number; intervalMs?: number },
): Promise<boolean> {
  const interval = opts.intervalMs ?? 500;
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    if (await isExpoManifestServed(port)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, interval));
  }
}
