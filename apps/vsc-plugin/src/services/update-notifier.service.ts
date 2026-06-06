import * as vscode from 'vscode';
import * as https from 'node:https';

/**
 * Best-effort "is there a newer version of this extension on the
 * Marketplace?" notifier. Mirrors the CLI's `updateNotifier.ts` —
 * fire-and-forget HTTPS check, 24-hour cache in VS Code's
 * extension-scoped `globalState`, semver numeric compare, never
 * blocks activation. When the marketplace reports a newer version a
 * single information message offers "Update now" (opens the
 * extension page with the Update button) / "Release notes" (opens
 * the marketplace listing) / "Later" (suppresses the banner for the
 * same version until something newer ships).
 *
 * The CLI auto-installs the new binary; we can't do that on a VS
 * Code extension — VS Code owns the install lifecycle. The user-
 * visible reasoning matches the CLI advisory: "recommended to fix
 * known issues" so QA-reported regressions land on the user as soon
 * as Marketplace publishes the fix.
 */

const EXTENSION_ID = 'CodeAgentMobile.codeagent-mobile';
const MARKETPLACE_QUERY_URL =
  'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
const OPEN_VSX_QUERY_URL =
  'https://open-vsx.org/api/CodeAgentMobile/codeagent-mobile/latest';
const TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 1500;
const STATE_KEY_CACHE = 'codeam.updateNotifier.cache';
const STATE_KEY_DISMISSED = 'codeam.updateNotifier.dismissedVersion';

interface CacheShape {
  fetchedAt: number;
  latest: string;
}

interface GlobalStateLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

interface CheckOptions {
  currentVersion: string;
  globalState: GlobalStateLike;
}

type Fetcher = () => Promise<string | null>;

let testFetcher: Fetcher | null = null;

/** Vitest seam — replaces the real marketplace fetch in story specs. */
export const _updateNotifierTestSeam = {
  setFetcher(fetcher: Fetcher | null): void {
    testFetcher = fetcher;
  },
};

/**
 * Public entry — call once at activation. Idempotent: re-running
 * within the 24 h cache window is cheap (one globalState read, no
 * network). Resolves once the banner decision is made (so callers
 * can chain telemetry / tests); production code typically
 * `void`-discards the promise.
 */
export async function checkForUpdatesNow(opts: CheckOptions): Promise<void> {
  // Test envs + CI should never see the banner.
  if (process.env.NODE_ENV === 'test' && !testFetcher) return;
  if (process.env.CODEAM_DISABLE_UPDATE_CHECK === '1') return;

  const { currentVersion, globalState } = opts;
  const cache = readCache(globalState);
  const fresh = cache && Date.now() - cache.fetchedAt < TTL_MS;

  let latest: string | null = null;
  if (fresh && cache) {
    latest = cache.latest;
  } else {
    latest = await runFetch();
    if (latest) {
      await writeCache(globalState, { fetchedAt: Date.now(), latest });
    }
  }

  if (!latest) return;
  if (compareSemver(latest, currentVersion) <= 0) return;

  // Suppress the banner if the user already chose "Later" for THIS
  // exact latest version. A newer publish clears the suppression
  // because the stored value won't match the new `latest` anymore.
  const dismissed = globalState.get<string>(STATE_KEY_DISMISSED);
  if (dismissed === latest) return;

  await showUpdateBanner(currentVersion, latest, globalState);
}

function readCache(state: GlobalStateLike): CacheShape | null {
  const raw = state.get<CacheShape>(STATE_KEY_CACHE);
  if (!raw) return null;
  if (typeof raw.fetchedAt !== 'number' || typeof raw.latest !== 'string') return null;
  return raw;
}

function writeCache(state: GlobalStateLike, cache: CacheShape): Thenable<void> {
  return state.update(STATE_KEY_CACHE, cache);
}

async function runFetch(): Promise<string | null> {
  if (testFetcher) return testFetcher();
  // Race VS Marketplace + Open VSX in parallel — whichever responds
  // first wins. Open VSX is the source of truth for Cursor/Windsurf
  // users; VS Marketplace blocks some forks from querying.
  const results = await Promise.allSettled([fetchMarketplace(), fetchOpenVsx()]);
  for (const r of results) {
    if (r.status === 'fulfilled' && typeof r.value === 'string') return r.value;
  }
  return null;
}

function fetchMarketplace(): Promise<string | null> {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      filters: [
        {
          criteria: [{ filterType: 7, value: EXTENSION_ID }],
          pageNumber: 1,
          pageSize: 1,
        },
      ],
      flags: 16, // IncludeVersions
    });
    const req = https.request(
      MARKETPLACE_QUERY_URL,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json;api-version=3.0-preview.1',
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buf += chunk;
        });
        res.on('end', () => {
          try {
            const json = JSON.parse(buf) as {
              results?: Array<{
                extensions?: Array<{ versions?: Array<{ version?: unknown }> }>;
              }>;
            };
            const version = json.results?.[0]?.extensions?.[0]?.versions?.[0]?.version;
            resolve(typeof version === 'string' ? version : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

function fetchOpenVsx(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.get(
      OPEN_VSX_QUERY_URL,
      { headers: { Accept: 'application/json' }, timeout: REQUEST_TIMEOUT_MS },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buf += chunk;
        });
        res.on('end', () => {
          try {
            const json = JSON.parse(buf) as { version?: unknown };
            resolve(typeof json.version === 'string' ? json.version : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

async function showUpdateBanner(
  currentVersion: string,
  latest: string,
  state: GlobalStateLike,
): Promise<void> {
  const message =
    `CodeAgent Mobile ${latest} is available (you have ${currentVersion}). ` +
    `Updating is recommended to fix known issues.`;
  const choice = await vscode.window.showInformationMessage(
    message,
    'Update now',
    'Release notes',
    'Later',
  );
  if (choice === 'Update now') {
    await vscode.commands.executeCommand(
      'workbench.extensions.search',
      `@id:${EXTENSION_ID}`,
    );
  } else if (choice === 'Release notes') {
    await vscode.env.openExternal(
      vscode.Uri.parse(
        `https://marketplace.visualstudio.com/items?itemName=${EXTENSION_ID}`,
      ),
    );
  } else if (choice === 'Later') {
    // Explicit Later silences the banner for this exact version.
    // Dismissing via the X (undefined) does NOT — clicking away once
    // shouldn't permanently mute future activations.
    await state.update(STATE_KEY_DISMISSED, latest);
  }
}

/**
 * Compare semver strings. Returns 1 if a > b, -1 if a < b, 0 if equal.
 * Strips pre-release suffixes — we never want to nag a stable user to
 * install a pre-release build.
 */
function compareSemver(a: string, b: string): number {
  const stripPre = (s: string): string => s.split('-')[0];
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
