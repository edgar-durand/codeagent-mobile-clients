import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseCoderabbitAuthEvent,
  runCoderabbitOAuthLogin,
  snapshotCredentialDir,
  diffCapturedCredential,
  type CoderabbitAuthEvent,
} from '../../../src/agents/coderabbit/oauth';

// Verbatim events captured from a live `coderabbit auth login --agent` run.
const AWAITING =
  '{"type":"status","phase":"auth","status":"awaiting_browser_auth","authUrl":"https://app.coderabbit.ai/login?client=cli&state=c54b863b&redirect_uri=http://127.0.0.1:51387/callback&variant=agent","fallbackAuthUrl":"https://app.coderabbit.ai/login?client=cli&state=c54b863b&redirect_uri=coderabbit-cli://auth-callback&variant=agent"}';
const AUTHED =
  '{"type":"status","phase":"auth","status":"authenticated","authenticated":true,"user":{"name":"Edgar","email":"e@x.com","username":"edgar-durand"},"authType":"oauth","provider":"github","currentOrg":{"name":"Acme"}}';

describe('coderabbit/parseCoderabbitAuthEvent', () => {
  it('parses the real event sequence', () => {
    expect(parseCoderabbitAuthEvent('{"type":"status","phase":"auth","status":"starting_login"}')).toEqual({
      kind: 'starting',
    });
    const aw = parseCoderabbitAuthEvent(AWAITING);
    expect(aw?.kind).toBe('awaiting_browser');
    expect((aw as Extract<CoderabbitAuthEvent, { kind: 'awaiting_browser' }>).authUrl).toContain(
      'app.coderabbit.ai/login',
    );
    expect(parseCoderabbitAuthEvent('{"status":"processing_callback"}')).toEqual({ kind: 'processing_callback' });
    expect(parseCoderabbitAuthEvent('{"status":"fetching_user"}')).toEqual({ kind: 'fetching_user' });
    expect(parseCoderabbitAuthEvent(AUTHED)).toMatchObject({
      kind: 'authenticated',
      provider: 'github',
      org: 'Acme',
      user: { username: 'edgar-durand' },
    });
  });

  it('maps failure variants to `failed`', () => {
    expect(
      parseCoderabbitAuthEvent(
        '{"type":"error","phase":"auth","status":"authentication_failed","message":"Failed to fetch user data"}',
      ),
    ).toEqual({ kind: 'failed', message: 'Failed to fetch user data' });
    expect(
      parseCoderabbitAuthEvent('{"type":"status","phase":"auth","status":"automatic_login_failed","message":"timed out"}'),
    ).toEqual({ kind: 'failed', message: 'timed out' });
  });

  it('ignores blank / non-JSON lines', () => {
    expect(parseCoderabbitAuthEvent('')).toBeNull();
    expect(parseCoderabbitAuthEvent('not json')).toBeNull();
  });
});

/** Minimal fake ChildProcess whose stdout we drive line-by-line. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe('coderabbit/runCoderabbitOAuthLogin', () => {
  it('surfaces the authUrl and resolves ok on `authenticated`', async () => {
    const child = fakeChild();
    const events: CoderabbitAuthEvent[] = [];
    const p = runCoderabbitOAuthLogin({
      spawn: () => child as never,
      onEvent: (e) => events.push(e),
      timeoutMs: 5_000,
    });
    child.stdout.emit('data', Buffer.from('{"status":"starting_login"}\n'));
    child.stdout.emit('data', Buffer.from(AWAITING + '\n'));
    child.stdout.emit('data', Buffer.from(AUTHED + '\n'));
    const result = await p;
    expect(result.ok).toBe(true);
    expect(result.provider).toBe('github');
    expect(result.org).toBe('Acme');
    // The app got the browser URL to open.
    const aw = events.find((e) => e.kind === 'awaiting_browser');
    expect(aw && (aw as Extract<CoderabbitAuthEvent, { kind: 'awaiting_browser' }>).authUrl).toContain('127.0.0.1');
    expect(child.kill).toHaveBeenCalled();
  });

  it('resolves not-ok on an auth failure event', async () => {
    const child = fakeChild();
    const p = runCoderabbitOAuthLogin({ spawn: () => child as never, timeoutMs: 5_000 });
    child.stdout.emit('data', Buffer.from('{"status":"starting_login"}\n'));
    child.stdout.emit(
      'data',
      Buffer.from('{"type":"error","status":"authentication_failed","message":"Failed to fetch user data"}\n'),
    );
    const result = await p;
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Failed to fetch user data');
  });

  it('resolves not-ok when the process exits before authenticating', async () => {
    const child = fakeChild();
    const p = runCoderabbitOAuthLogin({ spawn: () => child as never, timeoutMs: 5_000 });
    child.stdout.emit('data', Buffer.from('{"status":"starting_login"}\n'));
    child.emit('exit', 1);
    const result = await p;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('exited before authenticating');
  });
});

describe('coderabbit credential snapshot/diff capture', () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  });
  function seedHome(): string {
    const home = mkdtempSync(path.join(tmpdir(), 'cr-home-'));
    homes.push(home);
    mkdirSync(path.join(home, '.coderabbit', 'logs'), { recursive: true });
    writeFileSync(path.join(home, '.coderabbit', 'machine-id'), 'cli/abc');
    writeFileSync(path.join(home, '.coderabbit', 'doctor.json'), '{}');
    return home;
  }

  it('captures the NEW auth file the CLI writes on login (filename-agnostic)', () => {
    const home = seedHome();
    const before = snapshotCredentialDir(home);
    // Simulate the CLI persisting the credential after login.
    writeFileSync(path.join(home, '.coderabbit', 'auth.json'), '{"access_token":"opaque-blob"}');
    const captured = diffCapturedCredential(before, home);
    expect(captured).not.toBeNull();
    expect(captured!.file).toBe('auth.json');
    expect(captured!.contents).toContain('opaque-blob');
  });

  it('never captures doctor.json / machine-id / logs', () => {
    const home = seedHome();
    const before = snapshotCredentialDir(home);
    // Touch a non-credential file — must NOT be captured.
    const later = new Date(Date.now() + 5000);
    utimesSync(path.join(home, '.coderabbit', 'doctor.json'), later, later);
    expect(diffCapturedCredential(before, home)).toBeNull();
  });

  it('returns null when nothing changed', () => {
    const home = seedHome();
    const before = snapshotCredentialDir(home);
    expect(diffCapturedCredential(before, home)).toBeNull();
  });
});
