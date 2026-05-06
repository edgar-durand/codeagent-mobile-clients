import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as https from 'node:https';
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
    fs.writeFileSync(file, JSON.stringify(cache));
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
function compareSemver(a: string, b: string): number {
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
    notifyIfStale(current, cache.latest);
    return;
  }

  // Refresh in the background. Detach so the CLI can exit cleanly
  // without waiting on the registry call. The banner is shown on
  // the *next* run (this is how update-notifier behaves too).
  void fetchLatest().then((latest) => {
    if (!latest) return;
    writeCache({ fetchedAt: Date.now(), latest });
  });
}
