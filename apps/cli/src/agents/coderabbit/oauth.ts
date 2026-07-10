/**
 * CodeRabbit OAuth login driver (agent-mode / app-driven).
 *
 * CodeRabbit's sign-in is a CLI-driven LOOPBACK OAuth code flow. Run
 * `coderabbit auth login --agent` and it streams NDJSON status events to
 * stdout (reverse-engineered live 2026-07-09):
 *
 *   {"type":"status","phase":"auth","status":"starting_login"}
 *   {"type":"status","phase":"auth","status":"awaiting_browser_auth",
 *      "authUrl":"https://app.coderabbit.ai/login?client=cli&state=<uuid>
 *        &redirect_uri=http://127.0.0.1:<port>/callback&variant=agent",
 *      "fallbackAuthUrl":"...redirect_uri=coderabbit-cli://auth-callback..."}
 *   {"type":"status","phase":"auth","status":"processing_callback"}
 *   {"type":"status","phase":"auth","status":"fetching_user"}
 *   {"type":"status","phase":"auth","status":"authenticated","authenticated":true,
 *      "user":{name,email,username},"authType":...,"provider":...,"currentOrg":{name}}
 *   // failure variants:
 *   {"type":"status","phase":"auth","status":"automatic_login_failed","message":...}
 *   {"type":"error","phase":"auth","status":"authentication_failed","message":...}
 *
 * The CLI opens a local server, the user authorises in the browser, the
 * callback delivers a non-expiring opaque `access_token` which the CLI
 * persists under `~/.coderabbit/`. This module drives that flow headlessly:
 * it surfaces the `authUrl` (so the mobile app can open/show it) and resolves
 * once the CLI reports `authenticated` (or fails/times out). The captured
 * credential is read via {@link snapshotCredentialDir}/{@link diffCapturedCredential}
 * — filename-agnostic so we don't hard-code a storage path we can't yet confirm.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PYTHON_PTY_HELPER } from '../../services/pty/unix.strategy';

/** Normalised auth event — the app/relay only needs this shape. */
export type CoderabbitAuthEvent =
  | { kind: 'installing' }
  | { kind: 'starting' }
  | { kind: 'awaiting_browser'; authUrl: string; fallbackAuthUrl?: string }
  | { kind: 'processing_callback' }
  | { kind: 'fetching_user' }
  | {
      kind: 'authenticated';
      user?: { name?: string; email?: string; username?: string };
      authType?: string;
      provider?: string;
      org?: string;
    }
  | { kind: 'failed'; message: string }
  | { kind: 'unauthenticated' }
  | { kind: 'other'; status?: string };

interface RawAuthLine {
  type?: string;
  phase?: string;
  status?: string;
  authUrl?: string;
  fallbackAuthUrl?: string;
  message?: string;
  authenticated?: boolean;
  authType?: string;
  provider?: string;
  user?: { name?: string; email?: string; user_name?: string; username?: string };
  currentOrg?: { name?: string };
}

/** Parse one NDJSON stdout line from `coderabbit auth login --agent`. Returns
 *  null for blank/non-JSON/irrelevant lines. */
export function parseCoderabbitAuthEvent(line: string): CoderabbitAuthEvent | null {
  // Under a PTY the stream can carry ANSI CSI sequences / carriage returns
  // around the NDJSON — strip them so the `{`-prefix check + JSON.parse hold.
  // eslint-disable-next-line no-control-regex
  const l = line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
  if (!l || l[0] !== '{') return null;
  let rec: RawAuthLine;
  try {
    rec = JSON.parse(l) as RawAuthLine;
  } catch {
    return null;
  }
  // Terminal error event (`type:'error'`), or a failed status.
  if (rec.type === 'error' || rec.status === 'authentication_failed' || rec.status === 'automatic_login_failed') {
    return { kind: 'failed', message: rec.message ?? 'CodeRabbit authentication failed' };
  }
  switch (rec.status) {
    case 'starting_login':
      return { kind: 'starting' };
    case 'awaiting_browser_auth':
      return rec.authUrl
        ? { kind: 'awaiting_browser', authUrl: rec.authUrl, fallbackAuthUrl: rec.fallbackAuthUrl }
        : { kind: 'other', status: rec.status };
    case 'processing_callback':
      return { kind: 'processing_callback' };
    case 'fetching_user':
      return { kind: 'fetching_user' };
    case 'authenticated':
      return {
        kind: 'authenticated',
        user: rec.user
          ? { name: rec.user.name, email: rec.user.email, username: rec.user.username ?? rec.user.user_name }
          : undefined,
        authType: rec.authType,
        provider: rec.provider,
        org: rec.currentOrg?.name,
      };
    case 'not_authenticated':
      return { kind: 'unauthenticated' };
    default:
      return rec.status ? { kind: 'other', status: rec.status } : null;
  }
}

export interface OAuthLoginDeps {
  /** Injected spawner (tests provide a fake). Defaults to spawning
   *  `coderabbit auth login --agent` under a REAL PTY (see
   *  {@link spawnCoderabbitLoginProc}). The driver reads the child's stdout
   *  line-by-line and writes the intercepted callback to its stdin. */
  spawn?: (cmd: string, args: string[]) => ChildProcess;
  /** Called on every parsed event — surface `awaiting_browser`'s authUrl to the
   *  app so the user can open it. */
  onEvent?: (e: CoderabbitAuthEvent) => void;
  /** Overall budget before we give up (the browser step is user-paced). */
  timeoutMs?: number;
}

export interface OAuthLoginResult {
  ok: boolean;
  user?: { name?: string; email?: string; username?: string };
  authType?: string;
  provider?: string;
  org?: string;
  error?: string;
}

/** Resolve a python interpreter for the PTY helper (POSIX). */
function resolvePython(): string | null {
  for (const bin of ['python3', 'python']) {
    try {
      const r = spawnSync(bin, ['--version'], { stdio: 'ignore', timeout: 4000 });
      if (!r.error && r.status === 0) return bin;
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Spawn `coderabbit auth login --agent` under a REAL PTY.
 *
 * ⚠️ **Load-bearing for codespaces / self-hosted.** CodeRabbit refuses the
 * browser-OAuth flow when `stdout.isTTY === false` — it errors
 * `environment_unsupported: "Localhost callback and stdin fallback are
 * unavailable. Use --api-key"`. Under a PTY it emits the authUrl (with a
 * `coderabbit-cli://auth-callback` redirect) and accepts the token via **stdin**
 * (the "stdin fallback"). We reuse the Python PTY helper (same one the agent
 * session uses) so the child sees a TTY without needing our own stdin to be one.
 * On a box with no python (rare) we fall back to a direct spawn — which works on
 * a local machine with a browser, but a headless box then needs the API-key path.
 */
function spawnCoderabbitLoginProc(cmd: string, args: string[]): ChildProcess {
  const python = resolvePython();
  if (python) {
    const helper = path.join(os.tmpdir(), 'codeam-cr-pty.py');
    fs.writeFileSync(helper, PYTHON_PTY_HELPER, { mode: 0o644 });
    return spawn(python, [helper, cmd, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'xterm-256color', COLUMNS: '220', LINES: '50' },
      shell: false,
    });
  }
  return spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
}

// ── Pending-login registry (single in-flight login per CLI process) ──────────
// The `link_oauth` login runs in the background waiting for the mobile app to
// relay the intercepted OAuth redirect. That relay arrives as a SEPARATE relay
// command (`link_deliver_callback`), which reaches the running login through
// this registry and writes the callback to its stdin.
export interface PendingCoderabbitLogin {
  /** Write the intercepted callback URL to the login's stdin (PTY). */
  deliver(callbackUrl: string): void;
}
let pendingCoderabbitLogin: PendingCoderabbitLogin | null = null;
export function setPendingCoderabbitLogin(handle: PendingCoderabbitLogin | null): void {
  pendingCoderabbitLogin = handle;
}

export interface DeliverCallbackResult {
  ok: boolean;
  error?: string;
}

/**
 * Normalise whatever the mobile app relayed into the exact
 * `coderabbit-cli://auth-callback?…` line CodeRabbit's login reads from stdin.
 *
 * The app can relay EITHER form (both verified live 2026-07-10):
 *  - the raw `coderabbit-cli://auth-callback?access_token=…` URL (from an
 *    intercepted redirect), or a loopback `http://127.0.0.1:<port>/callback?…`;
 *  - the base64 **"Token Ready"** blob CodeRabbit shows on its authorize page for
 *    the agent flow ("Copy this token and paste it into Agent") — which base64-
 *    decodes to exactly that `coderabbit-cli://auth-callback?…` URL.
 *
 * Returns the URL to feed, or `null` if it's neither (so we never write an
 * arbitrary string to the login's stdin).
 */
function normalizeCoderabbitCallback(input: string): string | null {
  const s = (input ?? '').trim();
  if (!s) return null;
  if (
    /^coderabbit-cli:\/\/auth-callback/i.test(s) ||
    /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i.test(s)
  ) {
    return s;
  }
  // "Token Ready" base64 blob → decode to the callback URL.
  if (/^[A-Za-z0-9+/=]+$/.test(s) && s.length >= 40) {
    try {
      const decoded = Buffer.from(s, 'base64').toString('utf8');
      if (/^coderabbit-cli:\/\/auth-callback/i.test(decoded)) return decoded;
    } catch {
      /* not base64 */
    }
  }
  return null;
}

/**
 * Deliver a mobile-relayed CodeRabbit OAuth callback to the in-flight login by
 * writing it to the login process's **stdin** (→ PTY → coderabbit). This is how a
 * remote-host (codespace / self-hosted) login completes: CodeRabbit refuses the
 * browser flow headless UNTIL it's spawned under a PTY, then it delivers the token
 * as a base64 "paste into Agent" blob rather than a reachable redirect. The phone
 * WebView captures that blob and relays it here. Accepts the raw URL OR the base64
 * blob; refuses anything else.
 */
export function deliverPendingCoderabbitCallback(callbackUrl: string): DeliverCallbackResult {
  const url = normalizeCoderabbitCallback(callbackUrl);
  if (!url) return { ok: false, error: 'not a CodeRabbit callback token/URL' };
  if (!pendingCoderabbitLogin) {
    return { ok: false, error: 'no CodeRabbit login is awaiting a callback' };
  }
  try {
    pendingCoderabbitLogin.deliver(url);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'deliver failed' };
  }
}

/**
 * Drive `coderabbit auth login --agent` to completion. Resolves `{ok:true,...}`
 * once the CLI reports `authenticated`, or `{ok:false,error}` on failure /
 * early-exit / timeout. Never rejects. The caller reads the actual credential
 * with {@link diffCapturedCredential} once this resolves ok. While
 * `awaiting_browser` is live, the login is registered so
 * {@link deliverPendingCoderabbitCallback} can feed it the relayed redirect.
 */
export function runCoderabbitOAuthLogin(deps: OAuthLoginDeps): Promise<OAuthLoginResult> {
  const timeoutMs = deps.timeoutMs ?? 180_000;
  const spawnProc = deps.spawn ?? spawnCoderabbitLoginProc;
  return new Promise<OAuthLoginResult>((resolve) => {
    let settled = false;
    let stdout = '';
    let last: Extract<CoderabbitAuthEvent, { kind: 'authenticated' }> | null = null;
    const finish = (r: OAuthLoginResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      setPendingCoderabbitLogin(null);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve(r);
    };
    let child: ChildProcess;
    try {
      child = spawnProc('coderabbit', ['auth', 'login', '--agent']);
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : 'spawn failed' });
      return;
    }
    const timer = setTimeout(
      () => finish({ ok: false, error: 'CodeRabbit login timed out' }),
      timeoutMs,
    );
    const onLine = (line: string): void => {
      const e = parseCoderabbitAuthEvent(line);
      if (!e) return;
      deps.onEvent?.(e);
      if (e.kind === 'awaiting_browser') {
        // Register so the relayed redirect can be written to this login's stdin.
        setPendingCoderabbitLogin({
          deliver: (callbackUrl: string) => {
            child.stdin?.write(`${callbackUrl}\n`);
          },
        });
      } else if (e.kind === 'authenticated') {
        last = e;
        finish({ ok: true, user: e.user, authType: e.authType, provider: e.provider, org: e.org });
      } else if (e.kind === 'failed') {
        finish({ ok: false, error: e.message });
      }
    };
    child.stdout?.on('data', (b: Buffer) => {
      stdout += b.toString();
      let nl: number;
      while ((nl = stdout.indexOf('\n')) >= 0) {
        onLine(stdout.slice(0, nl));
        stdout = stdout.slice(nl + 1);
      }
    });
    child.on('error', (err) => finish({ ok: false, error: err.message }));
    child.on('exit', () => {
      if (stdout.trim()) onLine(stdout); // flush a trailing partial line
      finish(
        last
          ? { ok: true, user: last.user, authType: last.authType, provider: last.provider, org: last.org }
          : { ok: false, error: 'CodeRabbit login exited before authenticating' },
      );
    });
  });
}

/** CodeRabbit data dir (`~/.coderabbit`), override for tests via `home`. */
export function coderabbitDir(home?: string): string {
  return path.join(home ?? os.homedir(), '.coderabbit');
}

/** Files under `~/.coderabbit` that are NOT the credential (never captured). */
const NON_CREDENTIAL = new Set(['doctor.json', 'machine-id']);

export interface DirSnapshot {
  [file: string]: string; // filename → `mtimeMs:size` fingerprint
}

/**
 * Fingerprint the credential-bearing files in `~/.coderabbit` BEFORE login, so
 * we can detect exactly which file the CLI writes on success — filename-agnostic
 * (CodeRabbit's auth filename isn't documented and may shift). Skips the log dir
 * and the known non-credential files.
 */
export function snapshotCredentialDir(home?: string): DirSnapshot {
  const dir = coderabbitDir(home);
  const snap: DirSnapshot = {};
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return snap;
  }
  for (const e of entries) {
    if (!e.isFile() || NON_CREDENTIAL.has(e.name)) continue;
    try {
      const st = fs.statSync(path.join(dir, e.name));
      snap[e.name] = `${st.mtimeMs}:${st.size}`;
    } catch {
      /* skip */
    }
  }
  return snap;
}

export interface CapturedCredential {
  /** The auth file's basename under `~/.coderabbit` (e.g. `auth.json`). */
  file: string;
  /** Raw file contents — stored verbatim in the vault, written back verbatim
   *  to re-provision the credential in another session. */
  contents: string;
}

/**
 * After a successful login, return the credential file the CLI just wrote by
 * diffing against the pre-login {@link snapshotCredentialDir}. Picks the newest
 * new/changed non-log file. Returns null if nothing changed (nothing to store).
 */
export function diffCapturedCredential(before: DirSnapshot, home?: string): CapturedCredential | null {
  const dir = coderabbitDir(home);
  const after = snapshotCredentialDir(home);
  let best: { file: string; mtime: number } | null = null;
  for (const [file, fp] of Object.entries(after)) {
    if (before[file] === fp) continue; // unchanged
    const mtime = Number(fp.split(':')[0]);
    if (!best || mtime > best.mtime) best = { file, mtime };
  }
  if (!best) return null;
  try {
    return { file: best.file, contents: fs.readFileSync(path.join(dir, best.file), 'utf8') };
  } catch {
    return null;
  }
}

