import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as https from 'node:https';
import { execSync, spawnSync } from 'node:child_process';
import pc from 'picocolors';

/**
 * Minimal "is there a newer version on npm?" notifier. Keeps the
 * footprint zero-dependency: a fire-and-forget HTTPS request to the
 * npm registry, a 24-hour cache file under the user's config dir,
 * and a best-effort semver compare. Never blocks the CLI — every
 * I/O is non-blocking and any failure is silently swallowed.
 *
 * The caller passes the **current** version (we read it from the
 * tsup-injected `__CLI_VERSION__` constant in `index.ts`). The
 * notifier prints a one-line warning at the bottom of stderr when
 * a newer version is on the registry; otherwise it is invisible.
 */

declare const __CLI_VERSION__: string;

const PKG_NAME = 'codeam-cli';
const REGISTRY_URL = `https://registry.npmjs.org/${PKG_NAME}/latest`;
const TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 1500;

interface CacheShape {
  fetchedAt: number;
  latest: string;
}

function cachePath(): string {
  const dir = path.join(os.homedir(), '.codeam');
  return path.join(dir, 'update-check.json');
}

function readCache(): CacheShape | null {
  try {
    const raw = fs.readFileSync(cachePath(), 'utf8');
    const parsed = JSON.parse(raw) as CacheShape;
    if (typeof parsed.fetchedAt !== 'number' || typeof parsed.latest !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(cache: CacheShape): void {
  try {
    const file = cachePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Atomic stage-then-rename. The update cache is regenerable
    // (next CLI boot just fetches again), but a half-written JSON
    // makes readCache fail until it's overwritten — minor papercut
    // we avoid by mirroring config.ts's atomic pattern.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, file);
  } catch {
    /* unwritable home dir — give up silently */
  }
}

/**
 * Compare two semver strings. Returns 1 if a > b, -1 if a < b, 0 if
 * equal. Stops at the first numeric segment that differs; ignores
 * any pre-release suffix (`-rc.1` etc.) — we never want to nag a
 * user using a stable build to install a pre-release.
 */
export function compareSemver(a: string, b: string): number {
  const stripPre = (s: string) => s.split('-')[0];
  const aParts = stripPre(a).split('.').map(Number);
  const bParts = stripPre(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const ai = aParts[i] ?? 0;
    const bi = bParts[i] ?? 0;
    if (Number.isNaN(ai) || Number.isNaN(bi)) return 0;
    if (ai > bi) return 1;
    if (ai < bi) return -1;
  }
  return 0;
}

function fetchLatest(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.get(
      REGISTRY_URL,
      { headers: { Accept: 'application/json' }, timeout: REQUEST_TIMEOUT_MS },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { buf += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(buf) as { version?: unknown };
            if (typeof json.version === 'string') {
              resolve(json.version);
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/**
 * Print a newer-version banner if one is known. Returns the latest
 * version string (or null) so the caller can chain the asynchronous
 * refresh without re-reading the cache.
 */
function notifyIfStale(currentVersion: string, latest: string): void {
  if (compareSemver(latest, currentVersion) <= 0) return;
  const arrow = pc.dim('→');
  const cmd = pc.cyan('npm install -g codeam-cli');
  const lines = [
    '',
    `  ${pc.yellow('●')} ${pc.bold('Update available')} ${pc.dim(currentVersion)} ${arrow} ${pc.green(latest)}`,
    `    Run ${cmd} to upgrade.`,
    '',
  ];
  process.stderr.write(lines.join('\n'));
}

/**
 * Detect whether the current `codeam-cli` install is a `npm link` (the
 * common dev setup — the global binary is a symlink into the user's
 * working copy of the repo). Auto-update would clobber the symlink
 * with a real install and silently overwrite the developer's
 * source-of-truth, so we treat it as opt-out by detection.
 */
function isLinkedInstall(): boolean {
  try {
    const root = execSync('npm root -g', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    if (!root) return false;
    const pkgPath = path.join(root, PKG_NAME);
    return fs.lstatSync(pkgPath).isSymbolicLink();
  } catch {
    // `npm root -g` failed, path doesn't exist, etc. — assume it's a
    // regular install so the auto-update path is allowed to try.
    return false;
  }
}

/**
 * Synchronous self-upgrade. On a cache hit reporting a newer version,
 * run `npm install -g codeam-cli@latest` and re-exec the same argv so
 * the user's session continues on the new build without an extra
 * boot. Falls back to the stale-banner notice on:
 *   - npm-linked dev install (would clobber the repo).
 *   - `CODEAM_NO_AUTO_UPDATE=1` opt-out (CI / pinned codespaces).
 *   - npm install failure (permissions, network) — we keep going on
 *     the old version so the user is never stranded.
 *
 * The re-exec uses `codeam` from PATH, not `process.argv[1]`, so the
 * freshly-installed binary takes over instead of the now-stale entry
 * script the running process was launched from.
 */
function maybeAutoUpdate(currentVersion: string, latest: string): void {
  if (compareSemver(latest, currentVersion) <= 0) return;
  if (process.env.CODEAM_NO_AUTO_UPDATE === '1') {
    notifyIfStale(currentVersion, latest);
    return;
  }
  if (isLinkedInstall()) {
    // Dev path — show the nag but never touch the link.
    notifyIfStale(currentVersion, latest);
    return;
  }

  process.stderr.write(
    `\n  ${pc.yellow('●')} ${pc.bold('Updating codeam-cli')} ${pc.dim(currentVersion)} ${pc.dim('→')} ${pc.green(latest)}...\n\n`,
  );

  const install = spawnSync('npm', ['install', '-g', `${PKG_NAME}@latest`], {
    stdio: 'inherit',
    env: process.env,
  });
  if (install.status !== 0) {
    process.stderr.write(
      `\n  ${pc.red('!')} Update failed (exit ${install.status ?? '?'}). Continuing on ${currentVersion}.\n` +
        `    Run ${pc.cyan('npm install -g codeam-cli')} manually to retry.\n\n`,
    );
    return;
  }

  // Drop the cache so the next boot's TTL check re-fetches; otherwise
  // we'd keep the now-outdated "latest" string around for 24 h.
  try {
    fs.unlinkSync(cachePath());
  } catch {
    /* missing file is fine */
  }

  process.stderr.write(`  ${pc.green('✓')} Updated. Resuming session...\n\n`);
  const child = spawnSync('codeam', process.argv.slice(2), {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(child.status ?? 0);
}

/**
 * Synchronous, same-run auto-upgrade for the critical interactive commands
 * `link` and `pair`. Unlike {@link checkForUpdates}'s lazy two-run cadence
 * (first run only warms the cache, the upgrade fires on the *next* run), this
 * BLOCKS briefly to learn the latest version and upgrades + re-execs on THIS
 * run.
 *
 * Why these two commands specifically: `link` / `pair` capture credentials,
 * and a CLI older than v2.39.80 lacks the `/api/pairing/reconnect` fallback,
 * so under PoP enforcement it hard-fails with "Backend did not return a
 * pluginAuthToken" (the bug a user hit re-authenticating Claude on a fresh
 * codespace). A one-shot re-auth must never run on a stale binary, and the
 * lazy cadence would only fix it on a second attempt the user rarely makes.
 *
 * Best-effort: offline / npm-link dev / opt-out (`CODEAM_NO_AUTO_UPDATE=1`) /
 * install failure all fall through and continue on the current version
 * (delegated to {@link maybeAutoUpdate}). Honours the same NODE_ENV/CI/
 * disable guards as the notifier.
 */
export async function autoUpgradeBeforeCriticalCommand(): Promise<void> {
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.CODEAM_DISABLE_UPDATE_CHECK === '1') return;
  if (process.env.CI) return;

  const current = typeof __CLI_VERSION__ !== 'undefined' ? __CLI_VERSION__ : null;
  if (!current) return;

  // Prefer a fresh cache; otherwise fetch synchronously (short timeout) so the
  // upgrade can act on THIS run instead of the next.
  const cache = readCache();
  const fresh = cache && Date.now() - cache.fetchedAt < TTL_MS;
  let latest = fresh && cache ? cache.latest : null;
  if (!latest) {
    latest = await fetchLatest();
    if (latest) writeCache({ fetchedAt: Date.now(), latest });
  }
  if (!latest) return;

  // Shared upgrade path: handles the semver compare, opt-out, npm-link
  // detection, the `npm install -g` + re-exec, and the stale-banner fallback.
  maybeAutoUpdate(current, latest);
}

/**
 * Fire-and-forget. Reads the cache, prints if stale, and (in the
 * background) refreshes the cache so the *next* invocation sees the
 * latest. Never returns a promise the caller needs to await.
 */
export function checkForUpdates(): void {
  // Test environments + CI shouldn't see the banner or hit the registry.
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.CODEAM_DISABLE_UPDATE_CHECK === '1') return;
  if (process.env.CI) return;
  // Don't notify when stdout isn't a TTY (piping output, CI runs).
  if (!process.stdout.isTTY) return;

  const current = typeof __CLI_VERSION__ !== 'undefined' ? __CLI_VERSION__ : null;
  if (!current) return;

  const cache = readCache();
  const fresh = cache && Date.now() - cache.fetchedAt < TTL_MS;

  if (fresh && cache) {
    // Self-upgrade synchronously when a newer version is cached, then
    // re-exec the user's argv so the same boot continues on the new
    // build. Returns silently if up-to-date / opt-out / npm link.
    maybeAutoUpdate(current, cache.latest);
    return;
  }

  // Refresh in the background. Detach so the CLI can exit cleanly
  // without waiting on the registry call. The auto-update fires on
  // the *next* run (this matches update-notifier's classic cadence:
  // first boot warms the cache, second boot acts on it).
  void fetchLatest().then((latest) => {
    if (!latest) return;
    writeCache({ fetchedAt: Date.now(), latest });
  });
}
