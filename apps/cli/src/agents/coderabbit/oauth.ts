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

import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Normalised auth event — the app/relay only needs this shape. */
export type CoderabbitAuthEvent =
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
  const l = line.trim();
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
  /** Injected spawner (tests provide a fake). The impl is responsible for
   *  wiring `stdout` as a readable pipe; the driver reads it line-by-line. */
  spawn: (cmd: string, args: string[]) => ChildProcess;
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

/**
 * Drive `coderabbit auth login --agent` to completion. Resolves `{ok:true,...}`
 * once the CLI reports `authenticated`, or `{ok:false,error}` on failure /
 * early-exit / timeout. Never rejects. The caller reads the actual credential
 * with {@link diffCapturedCredential} once this resolves ok.
 */
export function runCoderabbitOAuthLogin(deps: OAuthLoginDeps): Promise<OAuthLoginResult> {
  const timeoutMs = deps.timeoutMs ?? 180_000;
  return new Promise<OAuthLoginResult>((resolve) => {
    let settled = false;
    let stdout = '';
    let last: Extract<CoderabbitAuthEvent, { kind: 'authenticated' }> | null = null;
    const finish = (r: OAuthLoginResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve(r);
    };
    let child: ChildProcess;
    try {
      child = deps.spawn('coderabbit', ['auth', 'login', '--agent']);
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
      if (e.kind === 'authenticated') {
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
