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

import { spawn, spawnSync } from 'node:child_process';
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
    const stored = deps.uploadCredential ? await deps.uploadCredential('api_key', key) : false;
    return { ...res, linked: stored, error: stored ? undefined : 'Failed to store API key' };
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
    const login: OAuthLoginResult = await runOAuth({
      spawn: (cmd, args) => spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }),
      onEvent: deps.onEvent,
    });
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
