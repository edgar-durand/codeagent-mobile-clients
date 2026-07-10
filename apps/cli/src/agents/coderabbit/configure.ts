/**
 * CodeRabbit reviewer configuration — the orchestration behind the
 * `coderabbit_configure` relay command (the mobile "Link CodeRabbit reviewer" /
 * "Review" add-on). All four actions live here, DI'd so they unit-test without
 * spawning the real CLI:
 *
 *   - `status`      → is the CLI installed + logged in?
 *   - `link_oauth`  → drive the loopback OAuth (`coderabbit auth login --agent`),
 *                     stream the browser `authUrl` to the app, capture the
 *                     credential the CLI writes, hand it to the backend vault.
 *   - `link_apikey` → validate + store a CodeRabbit API key.
 *   - `review`      → run `coderabbit review --agent` and return the findings.
 *
 * Credentials are captured/stored FILENAME-AGNOSTICALLY (see oauth.ts) and
 * restored verbatim by `coderabbitProvisioner`, so this never parses the token
 * internals.
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import {
  runCoderabbitOAuthLogin,
  snapshotCredentialDir,
  diffCapturedCredential,
  type CoderabbitAuthEvent,
  type OAuthLoginResult,
  type DirSnapshot,
  type CapturedCredential,
} from './oauth';
import { ensureCoderabbitInstalled } from './installer';
import { createOsStrategy, type OsStrategy } from '../../os';
import type { BatchInvocationInput, BatchInvocationOutput } from '../strategy';

export type CoderabbitAction = 'status' | 'link_oauth' | 'link_apikey' | 'review';

export interface CoderabbitConfigureResult {
  action: CoderabbitAction;
  /** CodeRabbit is always a valid reviewer target (never "unsupported"). */
  supported: true;
  installed: boolean;
  loggedIn: boolean;
  linked?: boolean;
  user?: { name?: string; email?: string; username?: string };
  provider?: string;
  org?: string;
  error?: string;
  review?: Pick<BatchInvocationOutput, 'markdown' | 'hunks' | 'stats'>;
}

export interface CoderabbitConfigureInput {
  action: CoderabbitAction;
  /** For `link_apikey`. */
  apiKey?: string;
  /** For `review` — change-set scope. */
  review?: BatchInvocationInput;
}

export interface CoderabbitConfigureDeps {
  os?: OsStrategy;
  /** Install the CLI on demand (link/review). Defaults to the real installer. */
  ensureInstalled?: (os: OsStrategy) => Promise<boolean>;
  /** True when `coderabbit auth status --agent` reports authenticated. */
  isLoggedIn?: () => boolean;
  runOAuthLogin?: typeof runCoderabbitOAuthLogin;
  snapshotDir?: () => DirSnapshot;
  captureCredential?: (before: DirSnapshot) => CapturedCredential | null;
  /** Run a review and return the structured output. */
  runReview?: (input: BatchInvocationInput) => Promise<BatchInvocationOutput>;
  /** Stream link/review progress to the app (→ postCoderabbitEvent). */
  onEvent?: (e: CoderabbitAuthEvent) => void;
  /** Hand a captured credential to the backend vault (→ postLinkCredential).
   *  Returns true on a successful store. */
  uploadCredential?: (method: 'oauth' | 'api_key', credential: string) => Promise<boolean>;
  /** Authenticate the session with a CodeRabbit API key
   *  (`coderabbit auth login --api-key <key>`). Defaults to the real spawn. */
  loginWithApiKey?: (key: string) => { ok: boolean; error?: string };
}

/** Default logged-in probe: `coderabbit auth status --agent` emits a JSON line
 *  with `authenticated: true|false`. */
function defaultIsLoggedIn(): boolean {
  const r = spawnSync('coderabbit', ['auth', 'status', '--agent'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (r.error || typeof r.stdout !== 'string') return false;
  for (const line of r.stdout.split('\n')) {
    const l = line.trim();
    if (!l.startsWith('{')) continue;
    try {
      const rec = JSON.parse(l) as { authenticated?: boolean; status?: string };
      if (rec.authenticated === true || rec.status === 'authenticated') return true;
      if (rec.authenticated === false || rec.status === 'not_authenticated') return false;
    } catch {
      /* skip */
    }
  }
  return false;
}

/**
 * OFFICIAL headless auth: `coderabbit auth login --api-key <key>` validates the
 * (Agentic) API key against CodeRabbit + stores the session credential. This —
 * NOT setting a `CODERABBIT_API_KEY` env var (the CLI does NOT read one) — is
 * what actually authenticates `coderabbit review` in a codespace / CI. Returns
 * `{ok:false, error}` with CodeRabbit's own message on an invalid/expired key.
 */
function defaultLoginWithApiKey(key: string): { ok: boolean; error?: string } {
  const r = spawnSync('coderabbit', ['auth', 'login', '--api-key', key], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  const out = `${typeof r.stdout === 'string' ? r.stdout : ''}${typeof r.stderr === 'string' ? r.stderr : ''}`;
  if (r.error) return { ok: false, error: r.error.message };
  // CodeRabbit prints "✗ API key authentication failed: <reason>" + exits non-zero.
  const failLine = out.match(/API key authentication failed:[^\n]*/i);
  if (failLine) return { ok: false, error: failLine[0].replace(/^[✗\s]+/, '').trim() };
  if (r.status !== 0) return { ok: false, error: out.trim() || 'API key authentication failed' };
  return { ok: true };
}

export async function configureCoderabbit(
  input: CoderabbitConfigureInput,
  deps: CoderabbitConfigureDeps = {},
): Promise<CoderabbitConfigureResult> {
  const os = deps.os ?? createOsStrategy();
  const ensureInstalled = deps.ensureInstalled ?? ensureCoderabbitInstalled;
  const isLoggedIn = deps.isLoggedIn ?? defaultIsLoggedIn;
  const runOAuth = deps.runOAuthLogin ?? runCoderabbitOAuthLogin;
  const snapshot = deps.snapshotDir ?? (() => snapshotCredentialDir());
  const capture = deps.captureCredential ?? ((b: DirSnapshot) => diffCapturedCredential(b));
  const loginWithApiKey = deps.loginWithApiKey ?? defaultLoginWithApiKey;

  // CodeRabbit installs to dirs a relayed session's process PATH often lacks, so
  // `findInPath` (and thus `installed`/`loggedIn`/`linked`) would falsely report
  // NOT installed even when the CLI is present + authenticated. Augment the PATH
  // for EVERY action (the installer only did it during install; `status` — which
  // drives the mobile "linked" state — never installs). Same class of PATH bug
  // as the `bd` symlink fix. Platform-aware: macOS/Linux/WSL use the POSIX dirs;
  // Windows (CodeRabbit officially needs WSL, but cover a native npm/scoop
  // install too) uses its user-profile equivalents.
  const home = os.homeDir();
  os.augmentPath(
    os.id === 'win32'
      ? [
          path.join(home, '.local', 'bin'),
          path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'npm'),
          path.join(home, 'scoop', 'shims'),
        ]
      : [path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'],
  );

  const installed = os.findInPath('coderabbit') !== null;
  const base = (): CoderabbitConfigureResult => ({
    action: input.action,
    supported: true,
    installed: os.findInPath('coderabbit') !== null,
    loggedIn: false,
  });

  if (input.action === 'status') {
    const res = base();
    res.loggedIn = res.installed ? isLoggedIn() : false;
    res.linked = res.loggedIn;
    return res;
  }

  if (input.action === 'link_apikey') {
    const res = base();
    const key = (input.apiKey ?? '').trim();
    if (!key) return { ...res, error: 'No API key provided' };
    if (!res.installed) {
      const ok = await ensureInstalled(os);
      res.installed = ok;
      if (!ok) return { ...res, error: 'CodeRabbit CLI could not be installed' };
    }
    // Authenticate the session with the key — the OFFICIAL headless method. Just
    // vaulting the key does NOT authenticate `coderabbit review` (the CLI reads
    // no CODERABBIT_API_KEY env), which is why API-key links used to 401 on
    // review. `auth login --api-key` validates + stores the session credential.
    const login = loginWithApiKey(key);
    if (!login.ok) {
      return { ...res, loggedIn: false, linked: false, error: login.error ?? 'Invalid or expired API key' };
    }
    // Vault the key so future hosts (codespace / self-hosted) can re-auth from it.
    const stored = deps.uploadCredential ? await deps.uploadCredential('api_key', key) : false;
    return {
      ...res,
      loggedIn: true,
      linked: stored,
      ...(stored ? {} : { error: 'Signed in, but storing the API key for reuse failed' }),
    };
  }

  if (input.action === 'link_oauth') {
    const res = base();
    if (!installed) {
      const ok = await ensureInstalled(os);
      res.installed = ok;
      if (!ok) return { ...res, error: 'CodeRabbit CLI could not be installed' };
    }
    // Fingerprint ~/.coderabbit BEFORE login so we can capture the exact file
    // the CLI writes on success.
    const before = snapshot();
    // No explicit `spawn` → runOAuth spawns under a REAL PTY, so CodeRabbit
    // allows the browser-OAuth flow even on a headless codespace / self-hosted
    // box (it refuses when stdout.isTTY is false). The intercepted redirect is
    // fed back via the login's stdin (deliverPendingCoderabbitCallback).
    const login: OAuthLoginResult = await runOAuth({ onEvent: deps.onEvent });
    if (!login.ok) {
      return { ...res, loggedIn: false, linked: false, error: login.error ?? 'CodeRabbit login failed' };
    }
    const cred = capture(before);
    if (!cred) {
      // Logged in per the CLI, but we couldn't identify the stored file — the
      // local session still works; only cross-session reuse is unavailable.
      return {
        ...res,
        installed: true,
        loggedIn: true,
        linked: false,
        user: login.user,
        provider: login.provider,
        org: login.org,
        error: 'Signed in, but the credential could not be captured for reuse',
      };
    }
    const blob = JSON.stringify({ file: cred.file, contents: cred.contents });
    const stored = deps.uploadCredential ? await deps.uploadCredential('oauth', blob) : false;
    return {
      ...res,
      installed: true,
      loggedIn: true,
      linked: stored,
      user: login.user,
      provider: login.provider,
      org: login.org,
      ...(stored ? {} : { error: 'Signed in, but storing the credential failed' }),
    };
  }

  // review
  const res = base();
  if (!res.installed) {
    const ok = await ensureInstalled(os);
    res.installed = ok;
    if (!ok) return { ...res, error: 'CodeRabbit CLI is not installed' };
  }
  if (!deps.runReview) return { ...res, error: 'No reviewer available' };
  const out = await deps.runReview(input.review ?? {});
  return {
    ...res,
    loggedIn: true,
    review: { markdown: out.markdown, hunks: out.hunks, stats: out.stats },
    ...(out.stats && typeof out.stats.error === 'string' ? { error: String(out.stats.error) } : {}),
  };
}
