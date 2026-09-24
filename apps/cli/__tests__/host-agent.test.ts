// codeagent-v07a: the supervisor mirrors its live children to
// `~/.codeam/host-agent-sessions.json`. Point that at a throwaway file so a
// dev machine's real state is never read or overwritten by these tests.
process.env.CODEAM_HOST_SESSION_STATE_FILE = `${process.env.TMPDIR ?? '/tmp'}/codeam-host-sessions-test-${process.pid}.json`;
// Each test starts from an EMPTY persisted set (a previous test's tracked
// child must not become this test's "sessions live at shutdown").
beforeEach(() => {
  try {
    fs.rmSync(process.env.CODEAM_HOST_SESSION_STATE_FILE as string, { force: true });
  } catch {
    /* ignore */
  }
});
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import * as childProcessModule from 'node:child_process';
import type { AgentAuth, AgentMetadata } from '@codeam/shared';
import { isOwnerOnly } from '../src/lib/restrict-to-owner';
import { encodeCwd } from '../src/agents/claude/history';

import {
  HostAgentSupervisor,
  SELF_UPDATE_DEFER_MAX_MS,
  resolveHostIdentity,
  defaultOnIdentityRejected,
  type ChildSpawner,
  detectPackageManager,
  RESUME_RETRY_BACKOFF_MS,
  RESUME_REPROBE_INTERVAL_MS,
  RESUME_HEALTHY_AFTER_MS,
  type OsRunner,
  type SelfUpdateResult,
  type DockerRunner,
} from '../src/commands/host-agent';
import { log } from '../src/services/logger';
import { hostEnroll } from '../src/commands/host';
import {
  hostIdentityPath,
  HostHttpError,
  isTerminalEnrollError,
  loadHostIdentity,
  MetricsCollector,
  reportProgress,
  reportSessionEvent,
  sendHostHeartbeat,
  type SealedHostIdentity,
} from '../src/commands/host/host-client';
import type { RemoteCommand } from '../src/services/command-relay.service';

// Wrap execFileSync so ONE test (defaultOnIdentityRejected's disableService
// call) can fake a single invocation without touching every other caller in
// this file's dependency graph (git-tooling's probe, service teardown, …):
// the default implementation forwards to the REAL execFileSync, so every
// existing test's behavior is unchanged unless a test explicitly overrides
// it with `mockImplementationOnce`. A bare `vi.spyOn` doesn't work here —
// vitest loads this file as ESM and node:child_process's named exports are
// non-configurable, so `vi.spyOn(childProcessModule, 'execFileSync')` throws
// "Module namespace is not configurable in ESM".
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

// Stub the git-tooling NETWORK ops (gh CLI download + `gh auth login`) so the
// cloneToken deploy path is deterministic + fast. Without this the cloneToken
// test does a REAL gh install/auth and times out on slow (windows) CI. Only the
// two network functions are overridden — codeamBinDir / defaultGitToolingRunner
// stay real via importActual.
vi.mock('../src/commands/host/git-tooling', async (importActual) => {
  const actual = await importActual<typeof import('../src/commands/host/git-tooling')>();
  return {
    ...actual,
    ensureGhCli: vi.fn(async () => 'gh'),
    ensureGhAuth: vi.fn(async () => undefined),
  };
});

// House-proxy config: default `readHouseProxyChildEnv` → {} so existing tests are
// unchanged; the resume-env test below opts in via mockReturnValueOnce.
vi.mock('../src/commands/host/house-proxy-config', async (importActual) => {
  const actual = await importActual<typeof import('../src/commands/host/house-proxy-config')>();
  return {
    // Keep the PURE builder real: `buildHouseProxyChildEnv` is what the deploy
    // path now uses to shape the house env (one builder for deploy, resume and
    // switch), and the house-deploy test below asserts that very shape. A stub
    // here made the deploy throw `undefined is not a function` inside its own
    // try/catch and the test saw "no spawn" instead of the real cause.
    ...actual,
    readHouseProxyChildEnv: vi.fn(() => ({})),
    persistHouseProxyConfig: vi.fn(),
    clearHouseProxyConfig: vi.fn(),
  };
});

// getActiveSession reads the real ~/.codeam config — default it to "no session"
// so start()'s auto-resume is a deterministic no-op unless a test opts in. Without
// this, a dev machine with real sessions would spawn a resume child (and fork a
// real `codeam`) inside every start() test.
vi.mock('../src/config', async (importActual) => {
  const actual = await importActual<typeof import('../src/config')>();
  return { ...actual, getActiveSession: vi.fn(() => null) };
});

// ── HOME isolation so ~/.codeam writes land in a throwaway dir ──────────
let tmpHome: string;
let origHome: string | undefined;
let origUserProfile: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-host-'));
  origHome = process.env.HOME;
  origUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  process.env.HOME = origHome;
  process.env.USERPROFILE = origUserProfile;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const IDENTITY: SealedHostIdentity = {
  hostId: 'host-123',
  hostToken: 'tok-abc',
  controlPluginId: 'sh-plugin-1',
  controlPollSecret: 'raw-control-poll-secret',
};

/** A fake child process that records SIGTERM kills. */
function fakeChild(): ChildProcess & { killed: boolean } {
  const emitter = new EventEmitter() as unknown as ChildProcess & { killed: boolean };
  emitter.killed = false;
  emitter.kill = ((_signal?: NodeJS.Signals | number) => {
    (emitter as { killed: boolean }).killed = true;
    return true;
  }) as ChildProcess['kill'];
  return emitter;
}

/**
 * A fake child with stdout/stderr streams (EventEmitters) so tests can feed
 * output and trigger the early-exit `failed` path.
 */
function fakeChildWithStreams(): ChildProcess & {
  killed: boolean;
  stdout: EventEmitter;
  stderr: EventEmitter;
} {
  const child = fakeChild();
  // The supervisor only ever calls `.on('data')` on these streams, so an
  // EventEmitter is a faithful stand-in for the real Readable at the test
  // boundary (a validated vitest-fake cast, like fakeChild itself).
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  (child as { stdout: unknown }).stdout = stdout;
  (child as { stderr: unknown }).stderr = stderr;
  return child as ChildProcess & { killed: boolean; stdout: EventEmitter; stderr: EventEmitter };
}

function deployCmd(over: Partial<Record<string, unknown>> = {}): RemoteCommand {
  return {
    id: 'cmd-1',
    sessionId: 'sh-plugin-1',
    type: 'self_hosted_deploy',
    payload: {
      deployId: 'deploy-1',
      repoOrPath: '/abs/path/that/exists',
      agentId: 'claude_code',
      sealedAgentAuth: JSON.stringify({ ciphertext: 'c', iv: 'i', authTag: 't', keyVersion: 1 }),
      autoPairToken: 'auto-xyz',
      ...over,
    },
  };
}

describe('host enroll — redeem flow', () => {
  it('posts osInfo, seals the identity 0600, and is idempotent', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        success: true,
        data: { hostId: 'h1', hostToken: 'long-lived', controlPluginId: 'sh-cp' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await hostEnroll(['--token=ENROLL', '--label=hetzner']);

    // 1) POSTed to redeem with the token + osInfo (distro/arch present).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/self-hosted/redeem');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.token).toBe('ENROLL');
    expect(body.label).toBe('hetzner');
    expect(typeof body.osInfo.distro).toBe('string');
    expect(typeof body.osInfo.arch).toBe('string');

    // 1b) Enrolled a control-plugin proof-of-possession poll secret:
    // body carries `pluginSecretHash` = sha256(controlPollSecret) as hex.
    expect(typeof body.pluginSecretHash).toBe('string');
    expect(body.pluginSecretHash).toMatch(/^[0-9a-f]{64}$/);

    // 2) Sealed to ~/.codeam/host-agent.json at mode 0600, WITH the raw
    // control-plugin poll secret persisted next to controlPluginId.
    const file = hostIdentityPath();
    expect(fs.existsSync(file)).toBe(true);
    expect(isOwnerOnly(file)).toBe(true);
    const sealed = loadHostIdentity();
    expect(sealed).toMatchObject({
      hostId: 'h1',
      hostToken: 'long-lived',
      controlPluginId: 'sh-cp',
    });
    expect(typeof sealed?.controlPollSecret).toBe('string');
    // The sealed raw secret must hash to the enrolled hash (matching scheme).
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(sealed!.controlPollSecret as string).digest('hex')).toBe(
      body.pluginSecretHash,
    );

    // 3) Idempotent — a second enroll does NOT re-redeem.
    await hostEnroll(['--token=ENROLL']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('defaults the label to os.hostname() when neither --label nor CODEAM_HOST_LABEL is set', async () => {
    const prev = process.env.CODEAM_HOST_LABEL;
    delete process.env.CODEAM_HOST_LABEL;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        success: true,
        data: { hostId: 'h1', hostToken: 't', controlPluginId: 'cp' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await hostEnroll(['--token=ENROLL']);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.label).toBe(os.hostname().slice(0, 80));
    if (prev !== undefined) process.env.CODEAM_HOST_LABEL = prev;
  });

  it('uses CODEAM_HOST_LABEL over the hostname (co-located host-agents / fleet box → "CodeAgent Box")', async () => {
    const prev = process.env.CODEAM_HOST_LABEL;
    process.env.CODEAM_HOST_LABEL = 'CodeAgent Box';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        success: true,
        data: { hostId: 'h1', hostToken: 't', controlPluginId: 'cp' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await hostEnroll(['--token=ENROLL']);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.label).toBe('CodeAgent Box');
    if (prev === undefined) delete process.env.CODEAM_HOST_LABEL;
    else process.env.CODEAM_HOST_LABEL = prev;
  });

  it('throws when no token and no existing identity', async () => {
    await expect(hostEnroll([])).rejects.toThrow(/requires --token/);
  });
});

describe('reportProgress — best-effort enrollment telemetry', () => {
  it('POSTs the enroll-token body to /enroll-progress (pre-redeem auth)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
    vi.stubGlobal('fetch', fetchMock);

    await reportProgress({ enrollToken: 'ENROLL' }, 'redeeming', 'redeeming enrollment token…');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/self-hosted/enroll-progress');
    const body = JSON.parse((init as { body: string }).body);
    expect(body).toEqual({
      enrollToken: 'ENROLL',
      step: 'redeeming',
      message: 'redeeming enrollment token…',
    });
    // No hostId/hostToken leak into the pre-redeem report.
    expect(body.hostId).toBeUndefined();
    expect(body.hostToken).toBeUndefined();
  });

  it('POSTs the host-token body to /enroll-progress (post-redeem auth)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
    vi.stubGlobal('fetch', fetchMock);

    await reportProgress(
      { hostId: 'host-123', hostToken: 'tok-abc' },
      'connected',
      'host-agent connected',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as { body: string }).body);
    expect(body).toEqual({
      hostId: 'host-123',
      hostToken: 'tok-abc',
      step: 'connected',
      message: 'host-agent connected',
    });
    expect(body.enrollToken).toBeUndefined();
  });

  it('swallows a failed POST — never throws (strictly best-effort)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      reportProgress({ enrollToken: 'ENROLL' }, 'redeeming', 'x'),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/** A fetch mock that succeeds for redeem and any best-effort progress POST. */
function redeemFetchMock(redeemData: {
  hostId: string;
  hostToken: string;
  controlPluginId: string;
}) {
  return vi.fn().mockImplementation(async (url: string) => {
    if (String(url).includes('/api/self-hosted/redeem')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ success: true, data: redeemData }),
      };
    }
    // enroll-progress + anything else: best-effort 200.
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  });
}

describe('resolveHostIdentity — redeem-first', () => {
  it('returns the sealed identity without redeeming when NO token is present', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fs.mkdirSync(path.dirname(hostIdentityPath()), { recursive: true });
    fs.writeFileSync(hostIdentityPath(), JSON.stringify(IDENTITY));

    const resolved = await resolveHostIdentity(undefined);
    expect(resolved).toEqual(IDENTITY);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redeems a present token even when a sealed identity already exists (re-enroll)', async () => {
    const fresh = { hostId: 'host-NEW', hostToken: 'tok-NEW', controlPluginId: 'sh-plugin-NEW' };
    const fetchMock = redeemFetchMock(fresh);
    vi.stubGlobal('fetch', fetchMock);
    // Pre-seal a STALE identity on disk (the old, deleted host).
    fs.mkdirSync(path.dirname(hostIdentityPath()), { recursive: true });
    fs.writeFileSync(hostIdentityPath(), JSON.stringify(IDENTITY));

    const resolved = await resolveHostIdentity('FRESH-ENROLL');

    // The fresh token wins — the stale identity is replaced, not reused. Redeem
    // now also mints a fresh control-plugin poll secret alongside the identity.
    expect(resolved).toMatchObject(fresh);
    expect(typeof resolved?.controlPollSecret).toBe('string');
    expect(loadHostIdentity()).toMatchObject(fresh);
    expect(typeof loadHostIdentity()?.controlPollSecret).toBe('string');
    const redeemCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/api/self-hosted/redeem'),
    );
    expect(redeemCall).toBeDefined();
  });

  it('falls back to the existing identity when redeem throws (e.g. a restart)', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/api/self-hosted/redeem')) {
        // Token already consumed (single-use) — backend rejects the redeem.
        return {
          ok: false,
          status: 409,
          statusText: 'Conflict',
          json: async () => ({ success: false, error: { code: 'TOKEN_USED' } }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    fs.mkdirSync(path.dirname(hostIdentityPath()), { recursive: true });
    fs.writeFileSync(hostIdentityPath(), JSON.stringify(IDENTITY));

    const resolved = await resolveHostIdentity('ALREADY-USED-TOKEN');

    // Redeem failed → fall back to the sealed identity (a plain restart).
    expect(resolved).toEqual(IDENTITY);
    expect(loadHostIdentity()).toEqual(IDENTITY);
  });

  it('resumes from the sealed identity when an EPHEMERAL enroll token expires on restart (fleet box)', async () => {
    // A fleet box carries its single-use token as a FIXED container env var, so
    // every restart re-attempts the redeem and hits a TERMINAL 410. With the
    // ephemeral flag set it must resume from the sealed identity, not die.
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/api/self-hosted/redeem')) {
        return {
          ok: false,
          status: 410,
          statusText: 'Gone',
          json: async () => ({ success: false, error: { code: 'ENROLL_TOKEN_EXPIRED' } }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    fs.mkdirSync(path.dirname(hostIdentityPath()), { recursive: true });
    fs.writeFileSync(hostIdentityPath(), JSON.stringify(IDENTITY));
    process.env.CODEAM_ENROLL_EPHEMERAL = '1';
    try {
      const resolved = await resolveHostIdentity('EXPIRED-BUT-EPHEMERAL');
      expect(resolved).toEqual(IDENTITY);
      expect(loadHostIdentity()).toEqual(IDENTITY);
    } finally {
      delete process.env.CODEAM_ENROLL_EPHEMERAL;
    }
  });

  it('resumes from the sealed identity on a terminal enroll error even when NOT ephemeral (plain restart, same consumed token — the P0 crash-loop fix)', async () => {
    // `Restart=always` bakes CODEAM_ENROLL_TOKEN in permanently on a normal
    // self-hosted box too (not just fleet/ephemeral ones) — any restart
    // after the first successful enroll replays the same, now-consumed
    // token and the backend can't tell that apart from a genuinely bad
    // token. A sealed identity on disk must win over a terminal redeem
    // rejection regardless of CODEAM_ENROLL_EPHEMERAL, or the box
    // crash-loops forever (the confirmed root cause of the first paying
    // subscriber's P0 outage).
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/api/self-hosted/redeem')) {
        return {
          ok: false,
          status: 410,
          statusText: 'Gone',
          json: async () => ({ success: false, error: { code: 'ENROLL_TOKEN_EXPIRED' } }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    fs.mkdirSync(path.dirname(hostIdentityPath()), { recursive: true });
    fs.writeFileSync(hostIdentityPath(), JSON.stringify(IDENTITY));
    delete process.env.CODEAM_ENROLL_EPHEMERAL;

    const resolved = await resolveHostIdentity('EXPIRED-TOKEN');
    expect(resolved).toEqual(IDENTITY);
    expect(loadHostIdentity()).toEqual(IDENTITY);
  });

  it('rethrows (transient) when redeem fails with 5xx AND there is no sealed identity', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/api/self-hosted/redeem')) {
        return {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          json: async () => ({ success: false, error: { code: 'INTERNAL_ERROR' } }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveHostIdentity('SOME-TOKEN')).rejects.toThrow();
  });

  it('returns null when neither identity nor token is available', async () => {
    expect(await resolveHostIdentity(undefined)).toBeNull();
  });
});

/**
 * Terminal enroll error detection — the host-agent must stop retrying when
 * the backend returns a terminal 4xx (410 ENROLL_TOKEN_EXPIRED / 400
 * ENROLL_TOKEN_INVALID) instead of looping forever against a permanently
 * invalid token.
 */
describe('resolveHostIdentity — terminal enroll errors stop retrying', () => {
  it('throws a clear user-facing message on ENROLL_TOKEN_EXPIRED (410) — no fallback', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/api/self-hosted/redeem')) {
        return {
          ok: false,
          status: 410,
          statusText: 'Gone',
          json: async () => ({
            success: false,
            error: { code: 'ENROLL_TOKEN_EXPIRED', message: 'Enrollment token has expired.' },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    // No sealed identity on disk — pure terminal failure.
    await expect(resolveHostIdentity('EXPIRED-TOKEN')).rejects.toThrow(
      /Enrollment token expired or invalid/,
    );
  });

  it('resumes from the sealed identity on ENROLL_TOKEN_EXPIRED instead of throwing, when a sealed identity exists', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/api/self-hosted/redeem')) {
        return {
          ok: false,
          status: 410,
          statusText: 'Gone',
          json: async () => ({
            success: false,
            error: { code: 'ENROLL_TOKEN_EXPIRED', message: 'Enrollment token has expired.' },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    // Sealed identity exists on disk — a terminal expiry now falls back to
    // it (the box's own `Restart=always` replaying an already-consumed
    // token is indistinguishable, server-side, from a genuinely bad one).
    fs.mkdirSync(path.dirname(hostIdentityPath()), { recursive: true });
    fs.writeFileSync(hostIdentityPath(), JSON.stringify(IDENTITY));

    const resolved = await resolveHostIdentity('EXPIRED-TOKEN');
    expect(resolved).toEqual(IDENTITY);
    expect(loadHostIdentity()).toEqual(IDENTITY);
  });

  it('throws a clear user-facing message on ENROLL_TOKEN_INVALID (400)', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/api/self-hosted/redeem')) {
        return {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          json: async () => ({
            success: false,
            error: { code: 'ENROLL_TOKEN_INVALID', message: 'Enrollment token is invalid.' },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveHostIdentity('GARBAGE-TOKEN')).rejects.toThrow(
      /Enrollment token expired or invalid/,
    );
  });

  it('falls back to sealed identity on a transient 5xx (not terminal)', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/api/self-hosted/redeem')) {
        return {
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          json: async () => ({ success: false, error: { code: 'INTERNAL_ERROR' } }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    fs.mkdirSync(path.dirname(hostIdentityPath()), { recursive: true });
    fs.writeFileSync(hostIdentityPath(), JSON.stringify(IDENTITY));

    // 5xx → transient → fall back to sealed identity
    const resolved = await resolveHostIdentity('TOKEN-DURING-OUTAGE');
    expect(resolved).toEqual(IDENTITY);
  });
});

describe('HostHttpError — terminal enroll error detection', () => {
  it('isTerminalEnrollError is true for ENROLL_TOKEN_EXPIRED', () => {
    const err = new HostHttpError('redeem failed', 410, 'ENROLL_TOKEN_EXPIRED');
    expect(err.isTerminalEnrollError).toBe(true);
    expect(isTerminalEnrollError(err)).toBe(true);
  });

  it('isTerminalEnrollError is true for ENROLL_TOKEN_INVALID', () => {
    const err = new HostHttpError('redeem failed', 400, 'ENROLL_TOKEN_INVALID');
    expect(err.isTerminalEnrollError).toBe(true);
    expect(isTerminalEnrollError(err)).toBe(true);
  });

  it('isTerminalEnrollError is false for a 5xx INTERNAL_ERROR (transient)', () => {
    const err = new HostHttpError('server error', 500, 'INTERNAL_ERROR');
    expect(err.isTerminalEnrollError).toBe(false);
    expect(isTerminalEnrollError(err)).toBe(false);
  });

  it('isTerminalEnrollError is false when no error code is set', () => {
    const err = new HostHttpError('network error', 0);
    expect(err.isTerminalEnrollError).toBe(false);
    expect(isTerminalEnrollError(err)).toBe(false);
  });

  it('isTerminalEnrollError is false for non-HostHttpError values', () => {
    expect(isTerminalEnrollError(new Error('plain error'))).toBe(false);
    expect(isTerminalEnrollError(null)).toBe(false);
    expect(isTerminalEnrollError('string')).toBe(false);
  });

  it('isAuthRejection and isTerminalEnrollError are orthogonal (4xx auth vs enroll)', () => {
    const authErr = new HostHttpError('host deleted', 404, undefined);
    expect(authErr.isAuthRejection).toBe(true);
    expect(authErr.isTerminalEnrollError).toBe(false);

    const enrollErr = new HostHttpError('token expired', 410, 'ENROLL_TOKEN_EXPIRED');
    expect(enrollErr.isAuthRejection).toBe(false);
    expect(enrollErr.isTerminalEnrollError).toBe(true);
  });
});

describe('HostAgentSupervisor — control channel reuse', () => {
  it('subscribes via the relay (not a new poller) on the controlPluginId', () => {
    const start = vi.fn();
    const stop = vi.fn();
    let capturedPluginId = '';
    let capturedMeta: AgentMetadata | null = null;
    let capturedPollSecret: string | undefined;
    const makeRelay = (
      pluginId: string,
      _onCommand: (cmd: RemoteCommand) => void | Promise<void>,
      meta: AgentMetadata,
      pollSecret?: string,
    ) => {
      capturedPluginId = pluginId;
      capturedMeta = meta;
      capturedPollSecret = pollSecret;
      return { start, stop, sendResult: vi.fn() };
    };

    const sup = new HostAgentSupervisor(IDENTITY, {
      makeRelay,
      // Heartbeat would hit the network — stub fetch to a no-op success.
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { ok: true } }),
        }),
    );
    sup.start();

    // The relay (the existing SSE-pull command-relay) is the control
    // channel — opened on the host's controlPluginId. No separate poller.
    expect(start).toHaveBeenCalledTimes(1);
    expect(capturedPluginId).toBe(IDENTITY.controlPluginId);
    expect(capturedMeta).not.toBeNull();
    // The control channel carries the sealed poll secret so its /pending +
    // /ack requests are proof-of-possession authenticated.
    expect(capturedPollSecret).toBe(IDENTITY.controlPollSecret);

    sup.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  // 2026-07-16 churn fix: a restart/self-update must auto-resume the user's
  // session (reconnect, same pluginId) instead of leaving it "CLI disconnected".
  it('auto-resumes the persisted session on boot via the resume spawner', async () => {
    const config = await import('../src/config');
    vi.mocked(config.getActiveSession).mockReturnValueOnce({
      id: 'sess-1',
      pluginId: 'plug-1',
      pollSecret: 'sec',
      agent: 'claude',
      userName: 'u',
      userEmail: 'e',
      plan: 'pro',
      pairedAt: 0,
      pluginAuthToken: 't',
    } as never);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, data: {} }) }),
    );
    const fakeProc = { stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, once: vi.fn(), kill: vi.fn() };
    const resumeSpawner = vi.fn(() => fakeProc as never);
    const sup = new HostAgentSupervisor(IDENTITY, {
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn(), sendResult: vi.fn() }),
      resumeSpawner,
    });
    sup.start();
    expect(resumeSpawner).toHaveBeenCalledTimes(1);
    sup.stop();
  });

  // 2026-07-29: a warm-codespace wake resumed in the host-agent's own cwd (the
  // wrapper repo root) → CODEAM_RESUME_LATEST found no prior conversation → a
  // fresh empty session. The persisted session cwd (the deploy workspace) must
  // be used so the real conversation resumes.
  it('resumes the session in its persisted deploy-workspace cwd (not the host-agent cwd)', async () => {
    const config = await import('../src/config');
    const os = await import('os');
    const workspaceCwd = os.tmpdir(); // an existing dir standing in for ~/.codeam/self-hosted/<deployId>
    vi.mocked(config.getActiveSession).mockReturnValueOnce({
      id: 'sess-1',
      pluginId: 'plug-1',
      pollSecret: 'sec',
      agent: 'claude',
      userName: 'u',
      userEmail: 'e',
      plan: 'pro',
      pairedAt: 0,
      pluginAuthToken: 't',
      cwd: workspaceCwd,
    } as never);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, data: {} }) }),
    );
    const fakeProc = { stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, once: vi.fn(), kill: vi.fn() };
    const resumeSpawner = vi.fn(() => fakeProc as never);
    const sup = new HostAgentSupervisor(IDENTITY, {
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn(), sendResult: vi.fn() }),
      resumeSpawner,
    });
    sup.start();
    expect(resumeSpawner).toHaveBeenCalledWith(expect.anything(), workspaceCwd);
    sup.stop();
  });

  // Regression (Rafael, 2026-08-05): a warm-codespace HOUSE-agent session broke
  // after sleep/wake with "Authentication required" because the resume re-injected
  // other per-deploy env but NOT the house-proxy env (ANTHROPIC_BASE_URL/AUTH_TOKEN).
  // The resume MUST carry the persisted house-proxy env so the woken agent still
  // authenticates through the proxy.
  it('re-injects the persisted house-proxy env into the resume (survives sleep/wake)', async () => {
    const config = await import('../src/config');
    const houseCfg = await import('../src/commands/host/house-proxy-config');
    vi.mocked(houseCfg.readHouseProxyChildEnv).mockReturnValueOnce({
      ANTHROPIC_BASE_URL: 'https://api.codeagent-mobile.com/api/v1/agent-proxy',
      ANTHROPIC_AUTH_TOKEN: 'HOUSE-TOK',
      ANTHROPIC_MODEL: 'MiniMax-M3',
    });
    vi.mocked(config.getActiveSession).mockReturnValueOnce({
      id: 'sess-1',
      pluginId: 'plug-1',
      pollSecret: 'sec',
      agent: 'claude',
      userName: 'u',
      userEmail: 'e',
      plan: 'pro',
      pairedAt: 0,
      pluginAuthToken: 't',
    } as never);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, data: {} }) }),
    );
    const fakeProc = { stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, once: vi.fn(), kill: vi.fn() };
    const resumeSpawner = vi.fn(() => fakeProc as never);
    const sup = new HostAgentSupervisor(IDENTITY, {
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn(), sendResult: vi.fn() }),
      resumeSpawner,
    });
    sup.start();
    const firstCall = resumeSpawner.mock.calls[0] as unknown as [Record<string, string>, string];
    const envArg = firstCall[0];
    expect(envArg.ANTHROPIC_BASE_URL).toBe('https://api.codeagent-mobile.com/api/v1/agent-proxy');
    expect(envArg.ANTHROPIC_AUTH_TOKEN).toBe('HOUSE-TOK');
    sup.stop();
  });

  it('does NOT resume when there is no persisted session', async () => {
    // getActiveSession defaults to null via the module mock above.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, data: {} }) }),
    );
    const resumeSpawner = vi.fn();
    const sup = new HostAgentSupervisor(IDENTITY, {
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn(), sendResult: vi.fn() }),
      resumeSpawner,
    });
    sup.start();
    expect(resumeSpawner).not.toHaveBeenCalled();
    sup.stop();
  });

  // ── Resume-spawn retry + visible failure (fleet-1, 2026-08-20) ────────────
  // The v2.65.13 self-update restarted the unit; the resumed kimi child died
  // `ENOENT — 'kimi' was not found on PATH` ONCE and the supervisor gave up
  // permanently + silently: the HOST heartbeat stayed online while the SESSION
  // sat dead for 3+ hours with nothing in the chat. The resume must (a) retry
  // with bounded backoff, (b) when exhausted, post ONE visible error bubble
  // into the session's chat and (c) keep a slow heartbeat-ridden re-probe so a
  // fixed cause heals without another manual restart.
  describe('resume-spawn retry / visible failure / heartbeat re-probe', () => {
    /** EventEmitter-backed fake child so tests can emit real 'exit' events. */
    function makeFakeResumeProc() {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn();
      return proc;
    }

    const SESSION = {
      id: 'sess-resume-1',
      pluginId: 'plug-resume-1',
      pollSecret: 'sec',
      agent: 'kimi',
      userName: 'u',
      userEmail: 'e',
      plan: 'pro',
      pairedAt: 0,
      pluginAuthToken: 'auth-tok-1',
    };

    async function withRetryHarness(
      run: (h: {
        sup: HostAgentSupervisor;
        procs: ReturnType<typeof makeFakeResumeProc>[];
        resumeSpawner: ReturnType<typeof vi.fn>;
        postResumeFailure: ReturnType<typeof vi.fn>;
      }) => Promise<void>,
    ): Promise<void> {
      const prevSelfUpdate = process.env.CODEAM_HOST_SELF_UPDATE_MS;
      process.env.CODEAM_HOST_SELF_UPDATE_MS = '0'; // keep fake-timer advances off npm
      const config = await import('../src/config');
      vi.mocked(config.getActiveSession).mockReturnValue(SESSION as never);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, data: {} }) }),
      );
      vi.useFakeTimers();
      const procs: ReturnType<typeof makeFakeResumeProc>[] = [];
      const resumeSpawner = vi.fn(() => {
        const p = makeFakeResumeProc();
        procs.push(p);
        return p as never;
      });
      const postResumeFailure = vi.fn(async () => undefined);
      const sup = new HostAgentSupervisor(IDENTITY, {
        makeRelay: () => ({ start: vi.fn(), stop: vi.fn(), sendResult: vi.fn() }),
        resumeSpawner,
        postResumeFailure,
      });
      try {
        sup.start();
        await run({ sup, procs, resumeSpawner, postResumeFailure });
      } finally {
        sup.stop();
        vi.useRealTimers();
        // The persistent mockReturnValue would leak into later tests
        // (restoreAllMocks does not reset module-factory vi.fn mocks) —
        // restore the module mock's "no session" default explicitly.
        vi.mocked(config.getActiveSession).mockReset();
        vi.mocked(config.getActiveSession).mockImplementation(() => null);
        if (prevSelfUpdate === undefined) delete process.env.CODEAM_HOST_SELF_UPDATE_MS;
        else process.env.CODEAM_HOST_SELF_UPDATE_MS = prevSelfUpdate;
      }
    }

    it('retries a dead resume child with the bounded backoff schedule', async () => {
      await withRetryHarness(async ({ procs, resumeSpawner }) => {
        expect(resumeSpawner).toHaveBeenCalledTimes(1);
        procs[0].emit('exit', 1);
        // Backoff: not a tick before the first delay elapses…
        await vi.advanceTimersByTimeAsync(RESUME_RETRY_BACKOFF_MS[0] - 1);
        expect(resumeSpawner).toHaveBeenCalledTimes(1);
        // …and exactly at it, the retry spawns.
        await vi.advanceTimersByTimeAsync(1);
        expect(resumeSpawner).toHaveBeenCalledTimes(2);
        // Second failure waits the SECOND backoff step (not the first again).
        procs[1].emit('exit', 1);
        await vi.advanceTimersByTimeAsync(RESUME_RETRY_BACKOFF_MS[0]);
        expect(resumeSpawner).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(RESUME_RETRY_BACKOFF_MS[1] - RESUME_RETRY_BACKOFF_MS[0]);
        expect(resumeSpawner).toHaveBeenCalledTimes(3);
      });
    });

    it('does NOT retry a clean exit (code 0)', async () => {
      await withRetryHarness(async ({ procs, resumeSpawner }) => {
        procs[0].emit('exit', 0);
        await vi.advanceTimersByTimeAsync(RESUME_RETRY_BACKOFF_MS[RESUME_RETRY_BACKOFF_MS.length - 1]);
        expect(resumeSpawner).toHaveBeenCalledTimes(1);
      });
    });

    // 2026-09-05 (dev2.brico warm codespace): the resumed child exit(0)-deferred
    // to a phantom daemon lock and the supervisor logged NOTHING — the only trace
    // was the absence of a child debug log. A clean exit of a child that was
    // supposed to run for hours is never "fine": say so, with the child's tail.
    it('logs a WARN with the child tail when the resumed child exits 0 without a resume child log line', async () => {
      const warnSpy = vi.spyOn(log, 'warn');
      await withRetryHarness(async ({ procs }) => {
        procs[0].stdout.emit(
          'data',
          Buffer.from('  A codeam daemon for this session is already running — deferring to it.\n'),
        );
        procs[0].emit('exit', 0);
        const msgs = warnSpy.mock.calls.map((c) => String(c[1]));
        expect(msgs.some((m) => /resumed session sess-res.*exited 0/.test(m) && /deferring to it/.test(m))).toBe(true);
      });
    });

    it('exhausts the retries, posts ONE visible error bubble carrying the child failure, then re-probes on the heartbeat', async () => {
      await withRetryHarness(async ({ procs, resumeSpawner, postResumeFailure }) => {
        // Burn the initial attempt + every backoff retry.
        for (let i = 0; i < RESUME_RETRY_BACKOFF_MS.length; i++) {
          procs[i].stderr.emit(
            'data',
            Buffer.from("acpClient — adapter spawn failed: ENOENT — 'kimi' was not found on PATH"),
          );
          procs[i].emit('exit', 1);
          await vi.advanceTimersByTimeAsync(RESUME_RETRY_BACKOFF_MS[i]);
        }
        expect(resumeSpawner).toHaveBeenCalledTimes(RESUME_RETRY_BACKOFF_MS.length + 1);
        // Final attempt dies too → exhausted → the visible bubble, exactly once,
        // addressed with the session's pairing identity and an honest reason.
        const last = procs[RESUME_RETRY_BACKOFF_MS.length];
        last.stderr.emit('data', Buffer.from("'kimi' was not found on PATH"));
        last.emit('exit', 1);
        expect(postResumeFailure).toHaveBeenCalledTimes(1);
        const [auth, message] = postResumeFailure.mock.calls[0] as unknown as [
          { sessionId: string; pluginId: string; pluginAuthToken: string },
          string,
        ];
        expect(auth).toEqual({
          sessionId: SESSION.id,
          pluginId: SESSION.pluginId,
          pluginAuthToken: SESSION.pluginAuthToken,
        });
        expect(message).toContain('failed to restart');
        expect(message).toContain("'kimi' was not found on PATH");
        // No timer-driven retry is pending anymore…
        await vi.advanceTimersByTimeAsync(RESUME_RETRY_BACKOFF_MS[RESUME_RETRY_BACKOFF_MS.length - 1]);
        const afterExhaust = resumeSpawner.mock.calls.length;
        expect(afterExhaust).toBe(RESUME_RETRY_BACKOFF_MS.length + 1);
        // …but the heartbeat rider re-probes after the slow interval, so a
        // fixed PATH heals WITHOUT a manual restart.
        await vi.advanceTimersByTimeAsync(RESUME_REPROBE_INTERVAL_MS + 21_000);
        expect(resumeSpawner.mock.calls.length).toBe(afterExhaust + 1);
        // A re-probe that fails again does NOT re-post the bubble.
        procs[procs.length - 1].emit('exit', 1);
        await vi.advanceTimersByTimeAsync(RESUME_REPROBE_INTERVAL_MS + 21_000);
        expect(postResumeFailure).toHaveBeenCalledTimes(1);
      });
    });

    it('resets the retry budget only after a resumed child stays healthy past the age gate', async () => {
      await withRetryHarness(async ({ procs, resumeSpawner }) => {
        procs[0].emit('exit', 1);
        await vi.advanceTimersByTimeAsync(RESUME_RETRY_BACKOFF_MS[0]);
        expect(resumeSpawner).toHaveBeenCalledTimes(2);
        // The retry child stays alive PAST the healthy-age gate (heartbeats
        // tick throughout) → the episode is over, budget + bubble reset.
        await vi.advanceTimersByTimeAsync(RESUME_HEALTHY_AFTER_MS + 21_000);
        // A LATER death starts a fresh episode from the FIRST backoff step.
        procs[1].emit('exit', 1);
        await vi.advanceTimersByTimeAsync(RESUME_RETRY_BACKOFF_MS[0]);
        expect(resumeSpawner).toHaveBeenCalledTimes(3);
      });
    });

    it('stop() cancels a pending resume retry', async () => {
      await withRetryHarness(async ({ sup, procs, resumeSpawner }) => {
        procs[0].emit('exit', 1);
        sup.stop();
        await vi.advanceTimersByTimeAsync(RESUME_RETRY_BACKOFF_MS[RESUME_RETRY_BACKOFF_MS.length - 1]);
        expect(resumeSpawner).toHaveBeenCalledTimes(1);
      });
    });
  });

  it('host_list_dir lists a directory (dirs first, dotfiles hidden) via the relay result', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-lsdir-'));
    fs.mkdirSync(path.join(tmp, 'projects'));
    fs.writeFileSync(path.join(tmp, 'readme.md'), 'x');
    fs.writeFileSync(path.join(tmp, '.hidden'), 'x'); // dotfile — must be filtered

    const sendResult = vi.fn();
    const sup = new HostAgentSupervisor(IDENTITY, {
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn(), sendResult }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) }),
    );
    sup.start();

    await sup.handleCommand({
      id: 'ls-1',
      type: 'host_list_dir',
      payload: { path: tmp },
    } as unknown as RemoteCommand);

    expect(sendResult).toHaveBeenCalledWith(
      'ls-1',
      'completed',
      expect.objectContaining({
        path: tmp,
        parent: path.dirname(tmp),
        entries: [
          { name: 'projects', isDir: true },
          { name: 'readme.md', isDir: false },
        ],
      }),
    );

    sup.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('self_hosted_cleanup removes the deploy workspace + house-claude dir (idempotent)', async () => {
    // HOME is tmpHome (beforeEach), so ~/.codeam/... resolves under the sandbox.
    const deployId = 'dep-abc123';
    const wsDir = path.join(tmpHome, '.codeam', 'self-hosted', deployId);
    const houseDir = path.join(tmpHome, '.codeam', 'house-claude', deployId);
    const otherWs = path.join(tmpHome, '.codeam', 'self-hosted', 'dep-KEEPME');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'repo.txt'), 'x');
    fs.mkdirSync(houseDir, { recursive: true });
    fs.mkdirSync(otherWs, { recursive: true }); // a DIFFERENT deploy must survive

    const sup = new HostAgentSupervisor(IDENTITY, {
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn(), sendResult: vi.fn() }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) }),
    );
    sup.start();

    await sup.handleCommand({
      id: 'cl-1',
      type: 'self_hosted_cleanup',
      payload: { deployId },
    } as unknown as RemoteCommand);

    expect(fs.existsSync(wsDir)).toBe(false);
    expect(fs.existsSync(houseDir)).toBe(false);
    expect(fs.existsSync(otherWs)).toBe(true); // another deploy's dir untouched

    // Idempotent: a second cleanup (dirs already gone) must not throw.
    await expect(
      sup.handleCommand({
        id: 'cl-2',
        type: 'self_hosted_cleanup',
        payload: { deployId },
      } as unknown as RemoteCommand),
    ).resolves.toBeUndefined();

    // Malformed payload (no deployId) is ignored, not crashed.
    await expect(
      sup.handleCommand({
        id: 'cl-3',
        type: 'self_hosted_cleanup',
        payload: {},
      } as unknown as RemoteCommand),
    ).resolves.toBeUndefined();

    sup.stop();
    fs.rmSync(otherWs, { recursive: true, force: true });
  });

  it('host_list_dir on an unreadable path returns a failed relay result (never throws)', async () => {
    const sendResult = vi.fn();
    const sup = new HostAgentSupervisor(IDENTITY, {
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn(), sendResult }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) }),
    );
    sup.start();

    await sup.handleCommand({
      id: 'ls-2',
      type: 'host_list_dir',
      payload: { path: '/no/such/dir/xyz-codeam' },
    } as unknown as RemoteCommand);

    // NB: assert status + error only — `listDir` normalizes the path via
    // path.resolve, which prepends a drive letter on Windows, so the exact
    // string isn't portable. What matters is it FAILED cleanly (never threw).
    expect(sendResult).toHaveBeenCalledWith(
      'ls-2',
      'failed',
      expect.objectContaining({ error: expect.anything() }),
    );
    sup.stop();
  });
});

describe('HostAgentSupervisor — command routing', () => {
  function makeSupervisor(spawnChild: ChildSpawner) {
    const resolveAgentAuth = vi
      .fn<(i: SealedHostIdentity, s: string) => Promise<AgentAuth>>()
      .mockResolvedValue({ kind: 'oauth_token', value: '{"claudeAiOauth":{}}' });
    return {
      sup: new HostAgentSupervisor(IDENTITY, { spawnChild, resolveAgentAuth }),
      resolveAgentAuth,
    };
  }

  it('self_hosted_deploy spawns a child with CODEAM_AUTO_TOKEN + the workspace cwd', async () => {
    // Use an absolute path that exists so prepareWorkspace returns it verbatim.
    const cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-ws-'));
    const calls: Array<{ env: Record<string, string>; cwd: string }> = [];
    const spawnChild: ChildSpawner = (env, cwd) => {
      calls.push({ env, cwd });
      return fakeChild();
    };
    const { sup, resolveAgentAuth } = makeSupervisor(spawnChild);

    await sup.handleCommand(deployCmd({ repoOrPath: cwdTarget }));

    expect(resolveAgentAuth).toHaveBeenCalledWith(IDENTITY, expect.any(String));
    expect(calls).toHaveLength(1);
    expect(calls[0].env.CODEAM_AUTO_TOKEN).toBe('auto-xyz');
    // Self-hosted is headless/autonomous → child runs in AUTO mode so the
    // agent doesn't stall every turn on a tool-permission prompt.
    expect(calls[0].env.CODEAM_AUTO_APPROVE).toBe('1');
    expect(calls[0].cwd).toBe(cwdTarget);
    expect(sup.childCount()).toBe(1);

    // Counterpart to the house-agent regression guard: a real LinkedAgent
    // (sealedAgentAuth) deploy must NOT relocate Claude's config — it runs as
    // the box owner's own authenticated `claude`, writing creds the normal way
    // (asserted below). CLAUDE_CONFIG_DIR isolation is house-agent-only.
    expect(calls[0].env.CLAUDE_CONFIG_DIR).toBeUndefined();

    // Credential was written the codespace way: ~/.claude/.credentials.json (0600).
    const credFile = path.join(tmpHome, '.claude', '.credentials.json');
    expect(fs.existsSync(credFile)).toBe(true);
    expect(isOwnerOnly(credFile)).toBe(true);

    fs.rmSync(cwdTarget, { recursive: true, force: true });
  });

  // Conversation continuity across a warm reconnect (Rafael/Stefano, 2026-08-06):
  // with the backend now deriving a STABLE deployId per (host, repo, branch), a
  // re-launch lands back in the SAME workspace cwd. The CLI must RESUME the prior
  // conversation there (else `client.start()` opens an empty chat and the history
  // looks gone).
  it('self_hosted_deploy resumes the latest conversation when the workspace already has one', async () => {
    const cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-ws-'));
    // Seed a prior conversation in this cwd's Claude namespace (BYO → ~/.claude).
    const projDir = path.join(tmpHome, '.claude', 'projects', encodeCwd(cwdTarget));
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'prior-abc.jsonl'), '{"type":"user"}\n');
    const calls: Array<{ env: Record<string, string> }> = [];
    const spawnChild: ChildSpawner = (env) => {
      calls.push({ env });
      return fakeChild();
    };
    const { sup } = makeSupervisor(spawnChild);

    await sup.handleCommand(deployCmd({ repoOrPath: cwdTarget }));

    expect(calls[0].env.CODEAM_RESUME_LATEST).toBe('1');
    fs.rmSync(cwdTarget, { recursive: true, force: true });
  });

  it('self_hosted_deploy does NOT resume on a first deploy (no prior conversation → fresh session)', async () => {
    const cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-ws-'));
    const calls: Array<{ env: Record<string, string> }> = [];
    const spawnChild: ChildSpawner = (env) => {
      calls.push({ env });
      return fakeChild();
    };
    const { sup } = makeSupervisor(spawnChild);

    await sup.handleCommand(deployCmd({ repoOrPath: cwdTarget }));

    expect(calls[0].env.CODEAM_RESUME_LATEST).toBeUndefined();
    fs.rmSync(cwdTarget, { recursive: true, force: true });
  });

  it('a task-dispatch deploy (suppressOnboardingWelcome) stays fresh even with a prior conversation', async () => {
    const cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-ws-'));
    const projDir = path.join(tmpHome, '.claude', 'projects', encodeCwd(cwdTarget));
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'prior-abc.jsonl'), '{"type":"user"}\n');
    const calls: Array<{ env: Record<string, string> }> = [];
    const spawnChild: ChildSpawner = (env) => {
      calls.push({ env });
      return fakeChild();
    };
    const { sup } = makeSupervisor(spawnChild);

    await sup.handleCommand(deployCmd({ repoOrPath: cwdTarget, suppressOnboardingWelcome: true }));

    // PR-review / work-item / conversation deploys want a focused fresh session.
    expect(calls[0].env.CODEAM_RESUME_LATEST).toBeUndefined();
    fs.rmSync(cwdTarget, { recursive: true, force: true });
  });

  it('house-agent deploy sets ANTHROPIC_BASE_URL/AUTH_TOKEN, makes NO unseal call, writes NO cred files', async () => {
    const cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-ws-'));
    const calls: Array<{ env: Record<string, string>; cwd: string; args?: string[] }> = [];
    const spawnChild: ChildSpawner = (env, cwd, args) => {
      calls.push({ env, cwd, args });
      return fakeChild();
    };
    const { sup, resolveAgentAuth } = makeSupervisor(spawnChild);

    await sup.handleCommand(
      deployCmd({
        repoOrPath: cwdTarget,
        agentId: 'house-codeagent-cloud',
        // House deploys carry houseProxy + NO sealedAgentAuth.
        sealedAgentAuth: undefined,
        houseProxy: {
          baseUrl: 'https://api.test/api/v1/agent-proxy',
          token: 'proxy-token-xyz',
          agentKind: 'claude',
        },
      }),
    );

    // No unseal round-trip on the house path.
    expect(resolveAgentAuth).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    // Managed-proxy env mirrors the codespace house bootstrap exactly.
    expect(calls[0].env.ANTHROPIC_BASE_URL).toBe('https://api.test/api/v1/agent-proxy');
    expect(calls[0].env.ANTHROPIC_AUTH_TOKEN).toBe('proxy-token-xyz');
    expect(calls[0].env.ANTHROPIC_MODEL).toBe('MiniMax-M3');
    expect(calls[0].env.CODEAM_AUTO_TOKEN).toBe('auto-xyz');
    // The deploy env comes from the ONE house builder now (it used to be a
    // hand-copied duplicate that drifted): the real-window knob that stops
    // autocompact thrashing must be here, not only on resume/switch.
    expect(calls[0].env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('512000');
    expect(calls[0].env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('512000');
    expect(calls[0].args).toEqual(['--agent=claude']);
    expect(sup.childCount()).toBe(1);

    // REGRESSION GUARD (self-hosted house-agent 401): the house agent is
    // Claude Code wired to the managed proxy via ANTHROPIC_AUTH_TOKEN. On a
    // REUSED self-hosted box, Claude's on-disk OAuth identity
    // (~/.claude/.credentials.json + ~/.claude.json) takes precedence over the
    // ANTHROPIC_AUTH_TOKEN gateway, so the box owner's stale personal login
    // wins and the proxy returns 401. The fix isolates the house agent's Claude
    // config into its own dir (CLAUDE_CONFIG_DIR) so it can NEVER read the box
    // owner's personal credentials. Without this env var the house deploy
    // regresses to a 401 on any box that already has a personal `claude` login.
    // Per-deploy isolation (multi-session): the house config dir is namespaced by
    // deployId so two concurrent house sessions on one box don't contend on
    // Claude's mutable config.
    const houseConfigDir = path.join(tmpHome, '.codeam', 'house-claude', 'deploy-1');
    expect(calls[0].env.CLAUDE_CONFIG_DIR).toBe(houseConfigDir);
    // …and the isolated dir is actually created up-front so Claude writes its
    // own session/config state there instead of falling back to ~/.claude.
    expect(fs.existsSync(houseConfigDir)).toBe(true);

    // No cred files written for the house agent.
    const credFile = path.join(tmpHome, '.claude', '.credentials.json');
    expect(fs.existsSync(credFile)).toBe(false);

    fs.rmSync(cwdTarget, { recursive: true, force: true });
  });

  it('self_hosted_refresh_credentials re-provisions the agent auth file IN PLACE (no spawn)', async () => {
    const { sup, resolveAgentAuth } = makeSupervisor(() => fakeChild());

    await sup.handleCommand({
      id: 'cmd-refresh',
      sessionId: 'sh-plugin-1',
      type: 'self_hosted_refresh_credentials',
      payload: { agentId: 'claude_code', sealedAgentAuth: 'sealed-fresh' },
    });

    // Unsealed the fresh credential…
    expect(resolveAgentAuth).toHaveBeenCalledWith(IDENTITY, 'sealed-fresh');
    // …and rewrote the agent's auth file in place (mock returns a claude oauth blob).
    expect(fs.existsSync(path.join(tmpHome, '.claude', '.credentials.json'))).toBe(true);
    // Refresh is in-place — no session child spawned.
    expect(sup.childCount()).toBe(0);
  });

  it('ignores a malformed self_hosted_refresh_credentials payload (no unseal/write)', async () => {
    const { sup, resolveAgentAuth } = makeSupervisor(() => fakeChild());

    await sup.handleCommand({
      id: 'cmd-bad',
      sessionId: 'sh-plugin-1',
      type: 'self_hosted_refresh_credentials',
      payload: { agentId: 'claude_code' }, // missing sealedAgentAuth
    });

    expect(resolveAgentAuth).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpHome, '.claude', '.credentials.json'))).toBe(false);
  });

  it('self_hosted_stop kills the matching child and untracks it', async () => {
    const cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-ws-'));
    const child = fakeChild();
    const spawnChild: ChildSpawner = () => child;
    const { sup } = makeSupervisor(spawnChild);

    await sup.handleCommand(deployCmd({ repoOrPath: cwdTarget, deployId: 'deploy-9' }));
    expect(sup.childCount()).toBe(1);

    // Backend stops by sessionId; self-hosted correlates it to the deployId.
    await sup.handleCommand({
      id: 'cmd-2',
      sessionId: 'sh-plugin-1',
      type: 'self_hosted_stop',
      payload: { sessionId: 'deploy-9' },
    });

    expect(child.killed).toBe(true);
    expect(sup.childCount()).toBe(0);

    fs.rmSync(cwdTarget, { recursive: true, force: true });
  });

  it('ignores an unknown command kind (no child spawned)', async () => {
    const spawnChild = vi.fn<ChildSpawner>(() => fakeChild());
    const { sup } = makeSupervisor(spawnChild);

    await sup.handleCommand({
      id: 'cmd-x',
      sessionId: 'sh-plugin-1',
      type: 'start_task',
      payload: { prompt: 'hi' },
    });

    expect(spawnChild).not.toHaveBeenCalled();
    expect(sup.childCount()).toBe(0);
  });

  it('ignores a malformed self_hosted_deploy (missing fields)', async () => {
    const spawnChild = vi.fn<ChildSpawner>(() => fakeChild());
    const { sup } = makeSupervisor(spawnChild);

    await sup.handleCommand({
      id: 'cmd-bad',
      sessionId: 'sh-plugin-1',
      type: 'self_hosted_deploy',
      payload: { deployId: 'd' }, // missing repoOrPath/agentId/sealedAgentAuth/autoPairToken
    });

    expect(spawnChild).not.toHaveBeenCalled();
    expect(sup.childCount()).toBe(0);
  });

  it('stop is a no-op when no child matches the sessionId', async () => {
    const spawnChild = vi.fn<ChildSpawner>(() => fakeChild());
    const { sup } = makeSupervisor(spawnChild);

    await expect(
      sup.handleCommand({
        id: 'cmd-z',
        sessionId: 'sh-plugin-1',
        type: 'self_hosted_stop',
        payload: { sessionId: 'nope' },
      }),
    ).resolves.toBeUndefined();
    expect(sup.childCount()).toBe(0);
  });
});

describe('HostAgentSupervisor — deploy-progress reporting', () => {
  /**
   * Collect the deploy-progress steps POSTed during a deploy, in order, plus
   * the raw bodies (so tests can assert no token leaks). Returns a fetch mock
   * that succeeds for the unseal round-trip and any best-effort progress POST.
   */
  function progressFetchMock() {
    const steps: string[] = [];
    const bodies: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (init?.body && typeof init.body === 'string') {
        if (u.includes('/api/self-hosted/deploy-progress')) {
          bodies.push(init.body);
          const parsed = JSON.parse(init.body) as { step?: string };
          if (parsed.step) steps.push(parsed.step);
        }
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: { ok: true } }) };
    });
    return { fetchMock, steps, bodies };
  }

  it('reports preparing → cloning → spawning → agent_starting in order on a clone deploy', async () => {
    const { fetchMock, steps } = progressFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    // A clone target: relative `owner/repo`. We stub the spawner so no real
    // git clone runs — but prepareWorkspace would try to clone. To keep this
    // a unit test, point at an absolute path that EXISTS so it skips cloning,
    // and assert the absolute-path step sequence (no `cloning`). The clone
    // step is covered separately by the workspace.test.ts URL+env tests.
    const cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-ws-'));
    const child = fakeChildWithStreams();
    const resolveAgentAuth = vi
      .fn<(i: SealedHostIdentity, s: string) => Promise<AgentAuth>>()
      .mockResolvedValue({ kind: 'oauth_token', value: '{"claudeAiOauth":{}}' });
    const sup = new HostAgentSupervisor(IDENTITY, {
      spawnChild: () => child,
      resolveAgentAuth,
    });

    await sup.handleCommand(deployCmd({ repoOrPath: cwdTarget }));
    // Let the fire-and-forget progress POSTs settle.
    await new Promise<void>((r) => setTimeout(r, 0));

    // Absolute-path deploy: no `cloning` step (nothing was cloned).
    expect(steps).toEqual(['preparing', 'spawning', 'agent_starting']);

    fs.rmSync(cwdTarget, { recursive: true, force: true });
  });

  it('reports a `failed` deploy-progress and does NOT throw when prepareWorkspace fails', async () => {
    const { fetchMock, steps, bodies } = progressFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const spawnChild = vi.fn<ChildSpawner>(() => fakeChildWithStreams());
    const resolveAgentAuth = vi
      .fn<(i: SealedHostIdentity, s: string) => Promise<AgentAuth>>()
      .mockResolvedValue({ kind: 'oauth_token', value: '{}' });
    const sup = new HostAgentSupervisor(IDENTITY, { spawnChild, resolveAgentAuth });

    // An absolute path that does NOT exist → prepareWorkspace throws.
    await expect(
      sup.handleCommand(deployCmd({ repoOrPath: '/does/not/exist/anywhere-xyz' })),
    ).resolves.toBeUndefined(); // dispatch never throws

    await new Promise<void>((r) => setTimeout(r, 0));

    // It reported `preparing` then `failed`; never spawned a child.
    expect(steps).toContain('preparing');
    expect(steps).toContain('failed');
    expect(spawnChild).not.toHaveBeenCalled();
    expect(sup.childCount()).toBe(0);

    // The failure body carries a concise message (no stack frames).
    const failedBody = bodies
      .map((b) => JSON.parse(b) as { step: string; message: string })
      .find((b) => b.step === 'failed');
    expect(failedBody).toBeDefined();
    expect(failedBody!.message).toContain('/does/not/exist/anywhere-xyz');
    expect(failedBody!.message).not.toContain('\n    at '); // no stack
  });

  it('reports `failed` with the captured output tail on an early non-zero child exit', async () => {
    const { fetchMock, steps, bodies } = progressFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-ws-'));
    const child = fakeChildWithStreams();
    const resolveAgentAuth = vi
      .fn<(i: SealedHostIdentity, s: string) => Promise<AgentAuth>>()
      .mockResolvedValue({ kind: 'oauth_token', value: '{}' });
    const sup = new HostAgentSupervisor(IDENTITY, {
      spawnChild: () => child,
      resolveAgentAuth,
    });

    await sup.handleCommand(deployCmd({ repoOrPath: cwdTarget }));

    // The child emits some stderr then dies non-zero (agent failed to boot).
    child.stderr.emit('data', Buffer.from('Error: could not authenticate agent\n'));
    (child as unknown as EventEmitter).emit('exit', 7);

    await new Promise<void>((r) => setTimeout(r, 0));

    const failedBody = bodies
      .map((b) => JSON.parse(b) as { step: string; message: string })
      .find((b) => b.step === 'failed');
    expect(steps).toContain('failed');
    expect(failedBody!.message).toContain('agent exited (7)');
    expect(failedBody!.message).toContain('could not authenticate agent');
    expect(sup.childCount()).toBe(0);

    fs.rmSync(cwdTarget, { recursive: true, force: true });
  });

  it('does NOT report `failed` on a clean child exit (SIGTERM teardown)', async () => {
    const { fetchMock, steps } = progressFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-ws-'));
    const child = fakeChildWithStreams();
    const resolveAgentAuth = vi
      .fn<(i: SealedHostIdentity, s: string) => Promise<AgentAuth>>()
      .mockResolvedValue({ kind: 'oauth_token', value: '{}' });
    const sup = new HostAgentSupervisor(IDENTITY, {
      spawnChild: () => child,
      resolveAgentAuth,
    });

    await sup.handleCommand(deployCmd({ repoOrPath: cwdTarget }));
    // Clean exit (code 0) — normal stop, not a failure.
    (child as unknown as EventEmitter).emit('exit', 0);
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(steps).not.toContain('failed');

    fs.rmSync(cwdTarget, { recursive: true, force: true });
  });

  it('accepts a deploy payload carrying a cloneToken (guard passes)', async () => {
    const { fetchMock } = progressFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-ws-'));
    const spawnChild = vi.fn<ChildSpawner>(() => fakeChildWithStreams());
    const resolveAgentAuth = vi
      .fn<(i: SealedHostIdentity, s: string) => Promise<AgentAuth>>()
      .mockResolvedValue({ kind: 'oauth_token', value: '{}' });
    const sup = new HostAgentSupervisor(IDENTITY, { spawnChild, resolveAgentAuth });

    await sup.handleCommand(deployCmd({ repoOrPath: cwdTarget, cloneToken: 'ghs_secret' }));

    // The deploy proceeded (guard accepted the cloneToken field).
    expect(spawnChild).toHaveBeenCalledTimes(1);

    fs.rmSync(cwdTarget, { recursive: true, force: true });
  });
});

describe('MetricsCollector — real system metrics', () => {
  it('collects RAM/CPU/latency in plausible ranges', () => {
    const c = new MetricsCollector();
    const m = c.collect();

    // RAM: used in (0, total], total positive, all integers.
    expect(Number.isInteger(m.ramTotalMb)).toBe(true);
    expect(Number.isInteger(m.ramUsedMb)).toBe(true);
    expect(m.ramTotalMb).toBeGreaterThan(0);
    expect(m.ramUsedMb).toBeGreaterThan(0);
    expect(m.ramUsedMb).toBeLessThanOrEqual(m.ramTotalMb);

    // CPU: integer percent 0–100.
    expect(Number.isInteger(m.cpuPct)).toBe(true);
    expect(m.cpuPct).toBeGreaterThanOrEqual(0);
    expect(m.cpuPct).toBeLessThanOrEqual(100);

    // Latency: first beat has no measurement yet → 0.
    expect(m.latencyMs).toBe(0);
  });

  it('computes CPU from the idle-vs-total delta across successive beats', () => {
    const c = new MetricsCollector();
    c.collect(); // seed the prior CPU sample
    const second = c.collect(); // now a real delta-based reading
    expect(Number.isInteger(second.cpuPct)).toBe(true);
    expect(second.cpuPct).toBeGreaterThanOrEqual(0);
    expect(second.cpuPct).toBeLessThanOrEqual(100);
  });

  it('carries a recorded latency into the next snapshot, rounded + clamped', () => {
    const c = new MetricsCollector();
    c.recordLatency(42.7);
    expect(c.collect().latencyMs).toBe(43);
    c.recordLatency(-5);
    expect(c.collect().latencyMs).toBe(0);
  });
});

describe('sendHostHeartbeat — metrics on the body + measured latency', () => {
  it('includes the metrics object and returns a measured round-trip', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { ok: true } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const latency = await sendHostHeartbeat(IDENTITY, {
      cpuPct: 12,
      ramUsedMb: 2048,
      ramTotalMb: 8192,
      latencyMs: 7,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/self-hosted/heartbeat');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.hostId).toBe(IDENTITY.hostId);
    expect(body.hostToken).toBe(IDENTITY.hostToken);
    expect(body.metrics).toEqual({ cpuPct: 12, ramUsedMb: 2048, ramTotalMb: 8192, latencyMs: 7 });

    // Measured round-trip is a non-negative integer (ms).
    expect(Number.isInteger(latency)).toBe(true);
    expect(latency).toBeGreaterThanOrEqual(0);
  });

  it('omits metrics from the body when none are supplied (back-compat)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { ok: true } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await sendHostHeartbeat(IDENTITY);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as { body: string }).body);
    expect(body.metrics).toBeUndefined();
  });
});

describe('HostAgentSupervisor — heartbeat metrics', () => {
  it('the heartbeat body carries a metrics object with plausible numbers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { ok: true } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const sup = new HostAgentSupervisor(IDENTITY, {
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn(), sendResult: vi.fn() }),
    });
    sup.start(); // fires one beat immediately (void this.beat())
    // Let the fire-and-forget beat's microtasks settle.
    await Promise.resolve();
    await Promise.resolve();
    sup.stop();

    expect(fetchMock).toHaveBeenCalled();
    const heartbeatCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/api/self-hosted/heartbeat'),
    );
    expect(heartbeatCall).toBeDefined();
    const body = JSON.parse((heartbeatCall![1] as { body: string }).body);
    expect(body.metrics).toBeDefined();
    expect(typeof body.metrics.cpuPct).toBe('number');
    expect(typeof body.metrics.ramUsedMb).toBe('number');
    expect(typeof body.metrics.ramTotalMb).toBe('number');
    expect(typeof body.metrics.latencyMs).toBe('number');
    expect(body.metrics.cpuPct).toBeGreaterThanOrEqual(0);
    expect(body.metrics.cpuPct).toBeLessThanOrEqual(100);
    expect(body.metrics.ramTotalMb).toBeGreaterThan(0);
  });

  it('still sends a heartbeat (without metrics) when metric collection throws', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { ok: true } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    // Inject a collector whose snapshot throws — the beat must survive it.
    const throwingCollector = {
      collect: () => {
        throw new Error('metrics boom');
      },
      recordLatency: vi.fn(),
    };

    const sup = new HostAgentSupervisor(IDENTITY, {
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn(), sendResult: vi.fn() }),
      metricsCollector: throwingCollector,
    });
    sup.start();
    await Promise.resolve();
    await Promise.resolve();
    sup.stop();

    const heartbeatCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/api/self-hosted/heartbeat'),
    );
    // The beat still fired despite the collector throwing…
    expect(heartbeatCall).toBeDefined();
    // …and it carried NO metrics (best-effort: never fail the beat).
    const body = JSON.parse((heartbeatCall![1] as { body: string }).body);
    expect(body.metrics).toBeUndefined();
    expect(body.hostId).toBe(IDENTITY.hostId);
  });
});

describe('sendHostHeartbeat — never carries session state (no polling)', () => {
  it('omits sessions from the body entirely', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { ok: true } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await sendHostHeartbeat(IDENTITY, { cpuPct: 1, ramUsedMb: 2, ramTotalMb: 3, latencyMs: 4 });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as { body: string }).body);
    expect(body.sessions).toBeUndefined();
    expect(body.metrics).toBeDefined();
  });
});

describe('reportSessionEvent — discrete session lifecycle (event-driven)', () => {
  function lastSessionEventBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const calls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/api/self-hosted/session-event'),
    );
    expect(calls.length).toBeGreaterThan(0);
    const last = calls[calls.length - 1];
    return JSON.parse((last[1] as { body: string }).body);
  }

  it("posts an 'ended' event with the deployId", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { ok: true } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await reportSessionEvent(IDENTITY, { event: 'ended', deployId: 'deploy-42' });

    const body = lastSessionEventBody(fetchMock);
    expect(body).toMatchObject({
      hostId: IDENTITY.hostId,
      hostToken: IDENTITY.hostToken,
      event: 'ended',
      deployId: 'deploy-42',
    });
  });

  // ⚠️ THE bug this whole block exists to prevent (rafaelph90.br@gmail.com,
  // 2026-09-01 and again 2026-09-02; 9 of 16 fleet boxes affected).
  //
  // The boot reconcile runs right after `resumePersistedSession`, and the id it
  // reports is matched server-side against `SelfHostedSession.deployId`. The
  // resume used to register its child under `session.id` — a PAIRED-SESSION id,
  // a different id space — so the backend found no match, read the live session
  // as unlisted, and ENDED its link. That row is the only thing tying the
  // session to its host, so the app then rendered a live CodeAgent Box session
  // as LOCAL, offering a reconnect the user cannot perform (no shell on our
  // VPS). This asserts the reported id is the DEPLOY id recovered from the
  // session's persisted workspace, and that the paired-session id is NOT sent.
  it('boot reconcile reports the resumed child under its DEPLOY id, never the paired-session id', async () => {
    const config = await import('../src/config');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { selfHostedWorkspaceRoot } = await import('../src/commands/host/workspace');

    const deployId = 'dep-11111111-2222-3333-4444-555555555555';
    const sessionId = 'sess-cmthdm5y6005pa69r4f56naoz';
    // A REAL directory at the real convention — `resumePersistedSession` only
    // honours a persisted cwd that exists on disk.
    const workspace = path.join(selfHostedWorkspaceRoot(), deployId);
    fs.mkdirSync(workspace, { recursive: true });

    try {
      vi.mocked(config.getActiveSession).mockReturnValueOnce({
        id: sessionId,
        pluginId: 'plug-1',
        pollSecret: 'sec',
        agent: 'claude',
        userName: 'u',
        userEmail: 'e',
        plan: 'pro',
        pairedAt: 0,
        pluginAuthToken: 't',
        cwd: workspace,
      } as never);

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { ok: true } }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const fakeProc = { stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, once: vi.fn(), kill: vi.fn() };
      const sup = new HostAgentSupervisor(IDENTITY, {
        makeRelay: () => ({ start: vi.fn(), stop: vi.fn(), sendResult: vi.fn() }),
        resumeSpawner: vi.fn(() => fakeProc as never),
      });
      sup.start();
      await vi.waitFor(() => {
        expect(
          fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/self-hosted/session-event')),
        ).toBe(true);
      });

      const body = lastSessionEventBody(fetchMock);
      expect(body.event).toBe('reconcile');
      expect(body.activeDeployIds).toEqual([deployId]);
      // The whole failure was reporting THIS instead.
      expect(body.activeDeployIds).not.toContain(sessionId);
      sup.stop();
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("posts a 'reconcile' event with the live deployId set", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { ok: true } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await reportSessionEvent(IDENTITY, { event: 'reconcile', activeDeployIds: ['a', 'b'] });

    const body = lastSessionEventBody(fetchMock);
    expect(body).toMatchObject({ event: 'reconcile', activeDeployIds: ['a', 'b'] });
  });
});

describe('HostAgentSupervisor — event-driven session lifecycle', () => {
  /** All session-event POST bodies seen by a fetch mock, in order. */
  function sessionEventBodies(fetchMock: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
    return fetchMock.mock.calls
      .filter((c) => String(c[0]).includes('/api/self-hosted/session-event'))
      .map((c) => JSON.parse((c[1] as { body: string }).body));
  }
  /** True if any heartbeat body carried a `sessions` field. */
  function anyHeartbeatHadSessions(fetchMock: ReturnType<typeof vi.fn>): boolean {
    return fetchMock.mock.calls
      .filter((c) => String(c[0]).includes('/api/self-hosted/heartbeat'))
      .some((c) => JSON.parse((c[1] as { body: string }).body).sessions !== undefined);
  }

  it('fires a boot reconcile (empty live set) on start and never puts sessions on the heartbeat', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { ok: true } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const sup = new HostAgentSupervisor(IDENTITY, {
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn(), sendResult: vi.fn() }),
    });
    sup.start();
    await Promise.resolve();
    await Promise.resolve();
    sup.stop();

    const events = sessionEventBodies(fetchMock);
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'reconcile', activeDeployIds: [] }),
    );
    expect(anyHeartbeatHadSessions(fetchMock)).toBe(false);
  });

  it("fires a one-shot 'ended' when a supervised child exits autonomously", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { ok: true } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-ws-'));
    const child = fakeChildWithStreams();
    const resolveAgentAuth = vi
      .fn<(i: SealedHostIdentity, s: string) => Promise<AgentAuth>>()
      .mockResolvedValue({ kind: 'oauth_token', value: '{"claudeAiOauth":{}}' });

    const sup = new HostAgentSupervisor(IDENTITY, {
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn(), sendResult: vi.fn() }),
      spawnChild: () => child,
      resolveAgentAuth,
    });

    await sup.handleCommand(
      deployCmd({ repoOrPath: cwdTarget, deployId: 'deploy-42', agentId: 'claude_code' }),
    );
    expect(sup.childCount()).toBe(1);

    // The agent process dies on its own (crash / completed) while still
    // tracked → the exit handler self-heals the map AND fires `ended`.
    // (Explicit stop is intentionally NOT a host event — the backend's
    // stopSession owns that END; stopChild deletes before exit so `tracked`
    // is already false there.)
    child.emit('exit', 0);
    await Promise.resolve();
    await Promise.resolve();
    expect(sup.childCount()).toBe(0);

    const events = sessionEventBodies(fetchMock);
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'ended', deployId: 'deploy-42' }),
    );
    expect(anyHeartbeatHadSessions(fetchMock)).toBe(false);

    fs.rmSync(cwdTarget, { recursive: true, force: true });
  });
});

describe('HostAgentSupervisor — self-heal on rejected host-token', () => {
  /** Seal the identity on disk so the wipe path has something to remove. */
  function sealIdentity(): void {
    fs.mkdirSync(path.dirname(hostIdentityPath()), { recursive: true });
    fs.writeFileSync(hostIdentityPath(), JSON.stringify(IDENTITY));
  }

  /** Let the fire-and-forget beat's full async error chain settle. */
  const flushBeat = () => new Promise<void>((r) => setTimeout(r, 0));

  it('wipes the identity + fires self-heal on a 404 heartbeat (host deleted)', async () => {
    sealIdentity();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({ success: false, error: { code: 'HOST_NOT_FOUND' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const onIdentityRejected = vi.fn(() => {
      // The default would process.exit; in the test we just wipe like prod.
      fs.rmSync(hostIdentityPath(), { force: true });
    });

    const sup = new HostAgentSupervisor(IDENTITY, {
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn(), sendResult: vi.fn() }),
      onIdentityRejected,
    });
    sup.start(); // fires one beat immediately
    await flushBeat();
    sup.stop();

    expect(onIdentityRejected).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(hostIdentityPath())).toBe(false);
  });

  it('wipes the identity + fires self-heal on a 401 heartbeat (token revoked)', async () => {
    sealIdentity();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ success: false, error: { code: 'BAD_TOKEN' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const onIdentityRejected = vi.fn();
    const sup = new HostAgentSupervisor(IDENTITY, {
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn(), sendResult: vi.fn() }),
      onIdentityRejected,
    });
    sup.start();
    await flushBeat();
    sup.stop();

    expect(onIdentityRejected).toHaveBeenCalledTimes(1);
  });

  it('does NOT self-heal on a transient network error (keeps retrying)', async () => {
    sealIdentity();
    // A raw network failure (fetch rejects) — NOT an auth rejection.
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    const onIdentityRejected = vi.fn();
    const sup = new HostAgentSupervisor(IDENTITY, {
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn(), sendResult: vi.fn() }),
      onIdentityRejected,
    });
    sup.start();
    await flushBeat();
    sup.stop();

    // Transient → no wipe, no exit; the sealed identity survives.
    expect(onIdentityRejected).not.toHaveBeenCalled();
    expect(fs.existsSync(hostIdentityPath())).toBe(true);
  });

  it('does NOT self-heal on a 500 heartbeat (transient server error)', async () => {
    sealIdentity();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ success: false, error: { code: 'OOPS' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const onIdentityRejected = vi.fn();
    const sup = new HostAgentSupervisor(IDENTITY, {
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn(), sendResult: vi.fn() }),
      onIdentityRejected,
    });
    sup.start();
    await flushBeat();
    sup.stop();

    expect(onIdentityRejected).not.toHaveBeenCalled();
    expect(fs.existsSync(hostIdentityPath())).toBe(true);
  });
});

describe('defaultOnIdentityRejected — disables the systemd unit before wiping/exiting', () => {
  it('calls systemctl disable --now BEFORE deleting the sealed identity and exiting(1)', () => {
    // A box that missed the best-effort self_hosted_wipe push (it was
    // offline when the host was deleted) must not restart-loop forever on
    // an identity that can never work again — the default self-heal action
    // now disables the systemd unit itself instead of relying solely on the
    // explicit self_hosted_wipe command to have done it.
    fs.mkdirSync(path.dirname(hostIdentityPath()), { recursive: true });
    fs.writeFileSync(hostIdentityPath(), JSON.stringify(IDENTITY));

    const execSpy = vi
      .mocked(childProcessModule.execFileSync)
      .mockImplementationOnce(() => Buffer.from(''));
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((_code?: string | number | null) => {
        throw new Error(`process.exit(${_code})`);
      }) as never);

    expect(() => defaultOnIdentityRejected()).toThrow('process.exit(1)');

    expect(execSpy).toHaveBeenCalledWith('systemctl', ['disable', '--now', 'codeam-host-agent'], {
      stdio: 'ignore',
    });
    expect(fs.existsSync(hostIdentityPath())).toBe(false);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('HostAgentSupervisor — self_hosted_wipe control command', () => {
  it('removes the sealed identity, disables the service, and fires the exit', async () => {
    fs.mkdirSync(path.dirname(hostIdentityPath()), { recursive: true });
    fs.writeFileSync(hostIdentityPath(), JSON.stringify(IDENTITY));
    // Heartbeat would hit the network during start() — stub a success.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { ok: true } }),
      }),
    );

    const relayStop = vi.fn();
    const disableService = vi.fn();
    const onIdentityRejected = vi.fn(() => {
      fs.rmSync(hostIdentityPath(), { force: true });
    });

    const sup = new HostAgentSupervisor(IDENTITY, {
      makeRelay: () => ({ start: vi.fn(), stop: relayStop, sendResult: vi.fn() }),
      disableService,
      onIdentityRejected,
    });
    sup.start();

    await sup.handleCommand({
      id: 'cmd-wipe',
      sessionId: 'sh-plugin-1',
      type: 'self_hosted_wipe',
      payload: {},
    });

    expect(relayStop).toHaveBeenCalled(); // children + channel torn down
    expect(disableService).toHaveBeenCalledTimes(1);
    expect(onIdentityRejected).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(hostIdentityPath())).toBe(false);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// isDeployPayload — payload validator back-compat + env injection
// ─────────────────────────────────────────────────────────────────────────────

describe('isDeployPayload — suppressOnboardingWelcome back-compat + env injection', () => {
  async function deployAndCaptureEnv(
    overrides: Record<string, unknown>,
  ): Promise<Record<string, string>> {
    const cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-ob-'));
    const calls: Array<{ env: Record<string, string> }> = [];
    const spawnChild: ChildSpawner = (env) => {
      calls.push({ env });
      return fakeChild();
    };
    const resolveAgentAuth = vi
      .fn<(i: SealedHostIdentity, s: string) => Promise<AgentAuth>>()
      .mockResolvedValue({ kind: 'oauth_token', value: '{"claudeAiOauth":{}}' });
    const sup = new HostAgentSupervisor(IDENTITY, { spawnChild, resolveAgentAuth });

    await sup.handleCommand(deployCmd({ repoOrPath: cwdTarget, ...overrides }));

    fs.rmSync(cwdTarget, { recursive: true, force: true });
    return calls[0]?.env ?? {};
  }

  it('omits CODEAM_ONBOARDING_DISABLED when the field is absent (older backend — back-compat)', async () => {
    const env = await deployAndCaptureEnv({});
    expect(env.CODEAM_ONBOARDING_DISABLED).toBeUndefined();
  });

  it('omits CODEAM_ONBOARDING_DISABLED when suppressOnboardingWelcome=false', async () => {
    const env = await deployAndCaptureEnv({ suppressOnboardingWelcome: false });
    expect(env.CODEAM_ONBOARDING_DISABLED).toBeUndefined();
  });

  it('sets CODEAM_ONBOARDING_DISABLED=1 on the child when suppressOnboardingWelcome=true', async () => {
    const env = await deployAndCaptureEnv({ suppressOnboardingWelcome: true });
    expect(env.CODEAM_ONBOARDING_DISABLED).toBe('1');
  });

  it('rejects a malformed suppressOnboardingWelcome (wrong type) → no child spawned', async () => {
    const spawnChild = vi.fn<ChildSpawner>(() => fakeChild());
    const resolveAgentAuth = vi
      .fn<(i: SealedHostIdentity, s: string) => Promise<AgentAuth>>()
      .mockResolvedValue({ kind: 'oauth_token', value: '{}' });
    const sup = new HostAgentSupervisor(IDENTITY, { spawnChild, resolveAgentAuth });

    await sup.handleCommand(deployCmd({ suppressOnboardingWelcome: 'yes' }));

    expect(spawnChild).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectPackageManager — coverage across distros
// ─────────────────────────────────────────────────────────────────────────────

describe('detectPackageManager — coverage across distros', () => {
  /** Minimal runner that reports a fixed set of commands as present on PATH. */
  function whichOnly(present: string[]): Pick<OsRunner, 'which'> {
    const set = new Set(present);
    return { which: (cmd: string): boolean => set.has(cmd) };
  }

  it('detects pacman (Arch)', () => {
    expect(detectPackageManager(whichOnly(['pacman']))).toBe('pacman');
  });

  it('detects zypper (openSUSE)', () => {
    expect(detectPackageManager(whichOnly(['zypper']))).toBe('zypper');
  });

  it('detects each of the six package managers in isolation', () => {
    expect(detectPackageManager(whichOnly(['apt-get']))).toBe('apt-get');
    expect(detectPackageManager(whichOnly(['apk']))).toBe('apk');
    expect(detectPackageManager(whichOnly(['dnf']))).toBe('dnf');
    expect(detectPackageManager(whichOnly(['yum']))).toBe('yum');
    expect(detectPackageManager(whichOnly(['pacman']))).toBe('pacman');
    expect(detectPackageManager(whichOnly(['zypper']))).toBe('zypper');
  });

  it('prefers apt-get over later managers when several are present', () => {
    // apt-get is first in preference order, pacman/zypper come last.
    expect(detectPackageManager(whichOnly(['apt-get', 'dnf', 'pacman', 'zypper']))).toBe('apt-get');
    // dnf precedes pacman/zypper.
    expect(detectPackageManager(whichOnly(['dnf', 'pacman', 'zypper']))).toBe('dnf');
  });

  it('returns null when no known package manager is present', () => {
    expect(detectPackageManager(whichOnly([]))).toBeNull();
    expect(detectPackageManager(whichOnly(['brew', 'nix']))).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Self-update — periodic npm check + install + restart
// ─────────────────────────────────────────────────────────────────────────────

describe('HostAgentSupervisor — periodic self-update', () => {
  /**
   * Build a supervisor with a stubbed relay (no HTTP) and an injected
   * `selfUpdate` + `onUpdated`, so the update logic is exercised without
   * touching real npm or `process.exit`.
   */
  function makeUpdateSupervisor(over: {
    selfUpdate: () => Promise<SelfUpdateResult>;
    onUpdated: (version: string) => void;
    spawnChild?: ChildSpawner;
  }) {
    return new HostAgentSupervisor(IDENTITY, {
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn(), sendResult: vi.fn() }),
      // No real heartbeat collection during these unit ticks.
      metricsCollector: {
        collect: () => {
          throw new Error('no metrics');
        },
        recordLatency: vi.fn(),
      },
      selfUpdate: over.selfUpdate,
      onUpdated: over.onUpdated,
      ...(over.spawnChild ? { spawnChild: over.spawnChild } : {}),
    });
  }

  it("installs + restarts when selfUpdate reports 'updated' (idle box)", async () => {
    const selfUpdate = vi
      .fn<() => Promise<SelfUpdateResult>>()
      .mockResolvedValue({ status: 'updated', version: '9.9.9' });
    const onUpdated = vi.fn();
    const sup = makeUpdateSupervisor({ selfUpdate, onUpdated });

    await sup.selfUpdateTick();

    expect(selfUpdate).toHaveBeenCalledTimes(1);
    // No children → restart fires immediately with the new version.
    expect(onUpdated).toHaveBeenCalledTimes(1);
    expect(onUpdated).toHaveBeenCalledWith('9.9.9');
  });

  it("does NOT restart when selfUpdate reports 'current'", async () => {
    const selfUpdate = vi
      .fn<() => Promise<SelfUpdateResult>>()
      .mockResolvedValue({ status: 'current' });
    const onUpdated = vi.fn();
    const sup = makeUpdateSupervisor({ selfUpdate, onUpdated });

    await sup.selfUpdateTick();

    expect(selfUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it("does NOT restart and does NOT crash when selfUpdate reports 'skipped'", async () => {
    const selfUpdate = vi
      .fn<() => Promise<SelfUpdateResult>>()
      .mockResolvedValue({ status: 'skipped' });
    const onUpdated = vi.fn();
    const sup = makeUpdateSupervisor({ selfUpdate, onUpdated });

    // Should resolve cleanly (no throw) and not restart.
    await expect(sup.selfUpdateTick()).resolves.toBeUndefined();
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it('never crashes the supervisor when the updater itself rejects', async () => {
    const selfUpdate = vi
      .fn<() => Promise<SelfUpdateResult>>()
      .mockRejectedValue(new Error('npm exploded'));
    const onUpdated = vi.fn();
    const sup = makeUpdateSupervisor({ selfUpdate, onUpdated });

    await expect(sup.selfUpdateTick()).resolves.toBeUndefined();
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it('DEFERS the restart while a child turn is in flight, then restarts when idle', async () => {
    // Spawn a (never-exiting) child via a real deploy so childCount() > 0.
    const cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-su-'));
    const child = fakeChildWithStreams();
    const spawnChild: ChildSpawner = () => child;
    const selfUpdate = vi
      .fn<() => Promise<SelfUpdateResult>>()
      .mockResolvedValue({ status: 'updated', version: '9.9.9' });
    const onUpdated = vi.fn();
    const sup = new HostAgentSupervisor(IDENTITY, {
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn(), sendResult: vi.fn() }),
      spawnChild,
      resolveAgentAuth: vi.fn().mockResolvedValue({ kind: 'oauth_token', value: '{}' }),
      selfUpdate,
      onUpdated,
    });

    await sup.handleCommand(deployCmd({ repoOrPath: cwdTarget }));
    expect(sup.childCount()).toBe(1);

    // First tick: installs but a child is busy → defers (no restart).
    await sup.selfUpdateTick();
    expect(selfUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdated).not.toHaveBeenCalled();

    // Child finishes its turn.
    child.emit('exit', 0);
    expect(sup.childCount()).toBe(0);

    // Next idle tick: the deferred restart fires. `selfUpdate` IS consulted
    // again — it must be, or a box that cannot restart also stops noticing new
    // versions (codeagent-e1uo) — but it is a `'current'` no-op when nothing is
    // newer, so nothing is re-installed. Once the restart happens the tick
    // returns, so a single deferred update yields exactly one restart.
    await sup.selfUpdateTick();
    expect(onUpdated).toHaveBeenCalledTimes(1);
    expect(onUpdated).toHaveBeenCalledWith('9.9.9');

    fs.rmSync(cwdTarget, { recursive: true, force: true });
  });

  /**
   * The deferral had no ceiling, and `children.size` is not what it claims.
   *
   * WHY THIS EXISTS — codeagent-e1uo, fleet box `…cmshfvyu9` (2026-08-24).
   * The log said, once an hour for over three days:
   *
   *   self-update: 2.65.17 installed but 1 child(ren) busy — deferring restart
   *
   * `children` holds LONG-LIVED SESSION PROCESSES, not turns in flight — a
   * `ChildSession` is `{deployId, proc, agent, startedAt}` with no notion of
   * activity at all. A paired box therefore has a child permanently, so the
   * restart was deferred permanently: the box sat on 2.65.16 with 2.66.1
   * published, and the `pendingRestartVersion` fast path meant it stopped even
   * LOOKING for newer versions — pinning it to a release from days earlier.
   *
   * We still prefer not to yank an active turn, so the deferral stays. It just
   * cannot be forever: past the ceiling we restart anyway (systemd brings the
   * session back), and while a restart is owed we keep checking the registry so
   * the pending version tracks the newest one available.
   */
  it('restarts anyway once the deferral ceiling is exceeded', async () => {
    const cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-su-'));
    const child = fakeChildWithStreams();
    const selfUpdate = vi
      .fn<() => Promise<SelfUpdateResult>>()
      .mockResolvedValue({ status: 'updated', version: '9.9.9' });
    const onUpdated = vi.fn();
    const now = vi.fn<() => number>().mockReturnValue(1_000_000);
    const sup = new HostAgentSupervisor(IDENTITY, {
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn(), sendResult: vi.fn() }),
      spawnChild: () => child,
      resolveAgentAuth: vi.fn().mockResolvedValue({ kind: 'oauth_token', value: '{}' }),
      selfUpdate,
      onUpdated,
      now,
    });

    await sup.handleCommand(deployCmd({ repoOrPath: cwdTarget }));
    expect(sup.childCount()).toBe(1);

    // The child NEVER exits — exactly the fleet-box shape.
    await sup.selfUpdateTick();
    expect(onUpdated).not.toHaveBeenCalled();

    // Still inside the ceiling: keep deferring.
    now.mockReturnValue(1_000_000 + SELF_UPDATE_DEFER_MAX_MS - 1);
    await sup.selfUpdateTick();
    expect(onUpdated).not.toHaveBeenCalled();

    // Past it: a box pinned on old code is worse than one dropped turn.
    now.mockReturnValue(1_000_000 + SELF_UPDATE_DEFER_MAX_MS + 1);
    await sup.selfUpdateTick();
    expect(onUpdated).toHaveBeenCalledWith('9.9.9');

    fs.rmSync(cwdTarget, { recursive: true, force: true });
  });

  it('keeps checking for newer versions while a restart is owed', async () => {
    const cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-su-'));
    const child = fakeChildWithStreams();
    const selfUpdate = vi
      .fn<() => Promise<SelfUpdateResult>>()
      .mockResolvedValueOnce({ status: 'updated', version: '2.65.17' })
      .mockResolvedValue({ status: 'updated', version: '2.66.1' });
    const onUpdated = vi.fn();
    const now = vi.fn<() => number>().mockReturnValue(1_000_000);
    const sup = new HostAgentSupervisor(IDENTITY, {
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn(), sendResult: vi.fn() }),
      spawnChild: () => child,
      resolveAgentAuth: vi.fn().mockResolvedValue({ kind: 'oauth_token', value: '{}' }),
      selfUpdate,
      onUpdated,
      now,
    });

    await sup.handleCommand(deployCmd({ repoOrPath: cwdTarget }));
    await sup.selfUpdateTick(); // owes a restart to 2.65.17, child busy
    await sup.selfUpdateTick(); // must NOT stop looking — 2.66.1 is out
    expect(selfUpdate).toHaveBeenCalledTimes(2);

    // When it finally restarts it must land on the NEWEST version seen, not
    // the one frozen at the first deferral.
    child.emit('exit', 0);
    await sup.selfUpdateTick();
    expect(onUpdated).toHaveBeenCalledWith('2.66.1');

    fs.rmSync(cwdTarget, { recursive: true, force: true });
  });

  it('disables the self-update timer when CODEAM_HOST_SELF_UPDATE_MS<=0', () => {
    const prev = process.env.CODEAM_HOST_SELF_UPDATE_MS;
    process.env.CODEAM_HOST_SELF_UPDATE_MS = '0';
    // start() fires one immediate heartbeat — stub fetch so it can't hit the net.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: {} }),
        }),
    );
    try {
      const selfUpdate = vi.fn<() => Promise<SelfUpdateResult>>();
      const sup = makeUpdateSupervisor({ selfUpdate, onUpdated: vi.fn() });
      sup.start();
      // The self-update timer must NOT be scheduled, so the injected updater
      // is never invoked. (The heartbeat timer is separate and still set.)
      sup.stop();
      expect(selfUpdate).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.CODEAM_HOST_SELF_UPDATE_MS;
      else process.env.CODEAM_HOST_SELF_UPDATE_MS = prev;
    }
  });

  it('schedules the self-update timer when the interval is positive', async () => {
    const prev = process.env.CODEAM_HOST_SELF_UPDATE_MS;
    process.env.CODEAM_HOST_SELF_UPDATE_MS = '50';
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: {} }),
        }),
    );
    vi.useFakeTimers();
    try {
      const selfUpdate = vi
        .fn<() => Promise<SelfUpdateResult>>()
        .mockResolvedValue({ status: 'current' });
      const onUpdated = vi.fn();
      const sup = makeUpdateSupervisor({ selfUpdate, onUpdated });
      sup.start();
      // The interval-driven tick fires after the configured delay.
      await vi.advanceTimersByTimeAsync(60);
      expect(selfUpdate).toHaveBeenCalled();
      sup.stop();
    } finally {
      vi.useRealTimers();
      if (prev === undefined) delete process.env.CODEAM_HOST_SELF_UPDATE_MS;
      else process.env.CODEAM_HOST_SELF_UPDATE_MS = prev;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HostAgentSupervisor — fleet control plane
//
// These tests rely on the tmpHome isolation set up in the top-level beforeEach
// so any write lands in a throwaway ~/.codeam.
// ─────────────────────────────────────────────────────────────────────────────

describe('HostAgentSupervisor — fleet control plane', () => {
  function makeDockerMock(
    result: { code?: number | null; stdout?: string; stderr?: string } = {},
  ) {
    const calls: string[][] = [];
    const opts: Array<{ timeoutMs?: number; env?: Record<string, string> } | undefined> = [];
    const docker: DockerRunner = {
      run: vi.fn(async (args: string[], runOpts) => {
        calls.push(args);
        opts.push(runOpts);
        return { code: result.code ?? 0, stdout: result.stdout ?? 'abcdef123456', stderr: result.stderr ?? '' };
      }),
    };
    return { docker, calls, opts };
  }

  function fleetCreateCmd(over: Partial<Record<string, unknown>> = {}): RemoteCommand {
    return {
      id: 'cmd-fleet-1',
      sessionId: 'sh-plugin-1',
      type: 'fleet_create_box',
      payload: {
        boxId: 'box-1',
        containerName: 'codeam-box-clu1a2b3c',
        enrollToken: 'super-secret-enroll-token',
        apiOrigin: 'https://api.codeagent-mobile.com',
        limits: { memoryMb: 1536, cpus: 1, pidsLimit: 512, diskGb: 10 },
        ...over,
      },
    };
  }

  function fleetPruneCmd(over: Partial<Record<string, unknown>> = {}): RemoteCommand {
    return {
      id: 'cmd-fleet-prune',
      sessionId: 'sh-plugin-1',
      type: 'fleet_prune_host',
      payload: { images: true, buildCache: true, ...over },
    };
  }

  function fleetRefCmd(type: string, over: Partial<Record<string, unknown>> = {}): RemoteCommand {
    return {
      id: 'cmd-fleet-2',
      sessionId: 'sh-plugin-1',
      type,
      payload: {
        boxId: 'box-1',
        containerName: 'codeam-box-clu1a2b3c',
        ...over,
      },
    };
  }

  afterEach(() => {
    delete process.env.CODEAM_FLEET_BOX_IMAGE;
  });

  it('fleet_create_box builds the full argv with every hard-isolation flag + the ops labels', async () => {
    const { docker, calls, opts } = makeDockerMock();
    process.env.CODEAM_FLEET_BOX_IMAGE = 'ghcr.io/edgar-durand/codeam-box:test';
    const sup = new HostAgentSupervisor(IDENTITY, { docker });

    await sup.handleCommand(fleetCreateCmd());

    // Two calls: a defensive `rm -f` of any dead same-name container
    // (wipe-exit/crash + RestartPolicy=no would otherwise collide the
    // `docker run --name` — the 2026-07-16 FLEET_RESCUE_FAILED incident),
    // then the real `run`. The rm never touches the volume (no -v flag).
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['rm', '-f', 'codeam-box-clu1a2b3c']);
    const args = calls[1];

    // Container identity + image.
    expect(args).toContain('run');
    expect(args[args.indexOf('--name') + 1]).toBe('codeam-box-clu1a2b3c');
    expect(args[args.length - 1]).toBe('ghcr.io/edgar-durand/codeam-box:test');
    // Explicit image override (int test / operator) — docker's default pull
    // policy, NEVER --pull=always (a local-only tag would fail to pull).
    expect(args).not.toContain('--pull=always');

    // Hard isolation invariants.
    expect(args[args.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(args[args.indexOf('--security-opt') + 1]).toBe('no-new-privileges');
    expect(args[args.indexOf('--memory') + 1]).toBe('1536m');
    expect(args[args.indexOf('--cpus') + 1]).toBe('1');
    expect(args[args.indexOf('--pids-limit') + 1]).toBe('512');
    expect(args[args.indexOf('--network') + 1]).toBe('fleet-net');

    // Named volume — SAME name as the container, mounted at /home/box; the
    // ONLY writable surface, no host bind mounts.
    expect(args).toContain('-v');
    expect(args[args.indexOf('-v') + 1]).toBe('codeam-box-clu1a2b3c:/home/box');

    // Ops labels (Edgar's Phase-2 requirement).
    const labelValues = args.reduce<string[]>((acc, a, i) => {
      if (args[i - 1] === '--label') acc.push(a);
      return acc;
    }, []);
    expect(labelValues).toContain('com.codeagent.user-id=clu1a2b3c');
    expect(labelValues).toContain('com.codeagent.box-id=box-1');
    expect(labelValues).toContain('com.codeagent.created-by=fleet');

    // Env passthrough to the entrypoint. The enroll token is a SECRET —
    // spec invariant #1 ("token via env, NEVER argv") — so it must appear
    // as a BARE `-e CODEAM_ENROLL_TOKEN` (no `=value`) in argv, and the
    // value string must appear NOWHERE in the argv array. `CODEAM_API_URL`
    // is not a secret and stays a normal `-e KEY=value`.
    const envPairs = args.reduce<string[]>((acc, a, i) => {
      if (args[i - 1] === '-e') acc.push(a);
      return acc;
    }, []);
    expect(envPairs).toContain('CODEAM_ENROLL_TOKEN');
    expect(envPairs).toContain('CODEAM_API_URL=https://api.codeagent-mobile.com');
    expect(args).not.toContain('CODEAM_ENROLL_TOKEN=super-secret-enroll-token');
    expect(args.some((a) => a.includes('super-secret-enroll-token'))).toBe(false);

    // The value is instead delivered via the runner's `env` option — the
    // `docker` CLI process's OWN env, which is how docker resolves a bare
    // `-e NAME`.
    expect(opts[1]?.env).toEqual({ CODEAM_ENROLL_TOKEN: 'super-secret-enroll-token' });
    // …and the secret is NOT handed to the defensive rm call.
    expect(opts[0]?.env).toBeUndefined();

    // NEVER --privileged, NEVER the docker.sock, NEVER any other bind mount.
    expect(args).not.toContain('--privileged');
    expect(args.join(' ')).not.toContain('docker.sock');
    // The only `-v` on the whole argv is the named volume asserted above.
    expect(args.filter((a) => a === '-v')).toHaveLength(1);
  });

  it('fleet_create_box defaults the image when CODEAM_FLEET_BOX_IMAGE is unset — and pulls it fresh', async () => {
    const { docker, calls } = makeDockerMock();
    const sup = new HostAgentSupervisor(IDENTITY, { docker });

    await sup.handleCommand(fleetCreateCmd());

    const run = calls[1];
    expect(run[run.length - 1]).toBe('ghcr.io/edgar-durand/codeam-box:latest');
    // Registry-default image: --pull=always so a new box never silently
    // runs the fleet host's STALE cached :latest (2026-07-16: the cache
    // had CLI 2.61.4 while the registry had 2.61.9).
    expect(run).toContain('--pull=always');
  });

  it('fleet_create_box proceeds to run even when the defensive rm fails hard', async () => {
    const calls: string[][] = [];
    const docker: DockerRunner = {
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        if (args[0] === 'rm') {
          return { code: 1, stdout: '', stderr: 'daemon hiccup' };
        }
        return { code: 0, stdout: 'abcdef123456', stderr: '' };
      }),
    };
    const sup = new HostAgentSupervisor(IDENTITY, { docker });

    await sup.handleCommand(fleetCreateCmd());

    // rm failed for a non-"missing container" reason — logged, NOT fatal;
    // the run still happens (it may fail name-in-use, which self-heals via
    // the provisioning-timeout sweep — strictly better than never trying).
    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toBe('run');
  });

  it('rejects a malformed fleet_create_box payload (bad containerName) — docker never invoked', async () => {
    const { docker, calls } = makeDockerMock();
    const sup = new HostAgentSupervisor(IDENTITY, { docker });

    await sup.handleCommand(fleetCreateCmd({ containerName: 'not-a-fleet-box; rm -rf /' }));

    expect(calls).toHaveLength(0);
  });

  it('rejects a malformed fleet_create_box payload (missing limits) — docker never invoked', async () => {
    const { docker, calls } = makeDockerMock();
    const sup = new HostAgentSupervisor(IDENTITY, { docker });

    await sup.handleCommand(fleetCreateCmd({ limits: undefined }));

    expect(calls).toHaveLength(0);
  });

  it('rejects a malformed fleet_create_box payload (missing enrollToken) — docker never invoked', async () => {
    const { docker, calls } = makeDockerMock();
    const sup = new HostAgentSupervisor(IDENTITY, { docker });

    await sup.handleCommand(fleetCreateCmd({ enrollToken: undefined }));

    expect(calls).toHaveLength(0);
  });


  /**
   * `fleet_migrate_box_image` — re-point a SLEEPING box at `:latest` without
   * waking it, so the version it was pinned to becomes reclaimable.
   *
   * Boxes are created with `--pull=always` on purpose, so each stays pinned to
   * the image it was born on, and Docker refuses to delete an image any
   * container references INCLUDING stopped ones — which is exactly what stops
   * the prune from destroying a sleeping user's box. Net: ~7.7 GB stranded per
   * lagging box (fleet-1, 2026-09-02: 9 boxes, 4 versions, ~31 GB).
   *
   * ⚠️ These tests are mostly about the ways this could DESTROY something,
   * because it operates on real users' boxes.
   */
  function makeMigrateDocker(opts: {
    running: string;
    containerImageId: string;
    latestImageId: string;
    rmCode?: number;
  }) {
    const calls: string[][] = [];
    const docker: DockerRunner = {
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        if (args[0] === 'inspect' && args.includes('{{.State.Running}}')) {
          return { code: 0, stdout: opts.running, stderr: '' };
        }
        if (args[0] === 'inspect' && args.includes('{{.Image}}')) {
          return { code: 0, stdout: opts.containerImageId, stderr: '' };
        }
        if (args[0] === 'inspect' && args.includes('{{.Id}}')) {
          return { code: 0, stdout: opts.latestImageId, stderr: '' };
        }
        if (args[0] === 'rm') {
          return { code: opts.rmCode ?? 0, stdout: '', stderr: opts.rmCode ? 'device busy' : '' };
        }
        return { code: 0, stdout: 'created', stderr: '' };
      }),
    };
    return { docker, calls };
  }

  const migratePayload = {
    boxId: 'box_1',
    containerName: 'codeam-box-cmqg8pcy100e8u80jfpss4a6s',
    apiOrigin: 'https://api.codeagent-mobile.com',
    limits: { memoryMb: 1536, cpus: 1, pidsLimit: 512, diskGb: 5 },
  };

  it('migrates a STOPPED box with a stale image: rm (volume kept) then CREATE', async () => {
    const { docker, calls } = makeMigrateDocker({
      running: 'false',
      containerImageId: 'sha256:old',
      latestImageId: 'sha256:new',
    });
    const sup = new HostAgentSupervisor(IDENTITY, { docker });
    await sup.handleCommand({
      id: 'c1',
      type: 'fleet_migrate_box_image',
      payload: migratePayload,
    } as never);

    const rm = calls.find((c) => c[0] === 'rm');
    expect(rm).toBeDefined();
    // ⚠️ NO `-v`: the named volume holds the user's workspace and sealed
    // identity, and losing it is the unrecoverable failure of this feature.
    expect(rm).not.toContain('-v');

    const create = calls.find((c) => c[0] === 'create');
    expect(create).toBeDefined();
    // `create`, never `run` — `run` would START the container, waking a box the
    // user left asleep (and 9 of them at once on a 16 GB host).
    expect(calls.some((c) => c[0] === 'run')).toBe(false);
    // No inline pull per box: the staleness probe already pulled once.
    expect(create).not.toContain('--pull=always');
  });

  it('REFUSES a RUNNING box even though the backend said SLEEPING', async () => {
    // The DB's view lags the host by a sweep, so a box that woke seconds ago is
    // still SLEEPING in its row. Re-creating it would kill a live agent
    // mid-turn, so the daemon — not the payload — is the authority.
    const { docker, calls } = makeMigrateDocker({
      running: 'true',
      containerImageId: 'sha256:old',
      latestImageId: 'sha256:new',
    });
    const sup = new HostAgentSupervisor(IDENTITY, { docker });
    await sup.handleCommand({
      id: 'c2',
      type: 'fleet_migrate_box_image',
      payload: migratePayload,
    } as never);

    expect(calls.some((c) => c[0] === 'rm')).toBe(false);
    expect(calls.some((c) => c[0] === 'create')).toBe(false);
  });

  it('skips a box already on :latest — idempotent, no churn', async () => {
    const { docker, calls } = makeMigrateDocker({
      running: 'false',
      containerImageId: 'sha256:same',
      latestImageId: 'sha256:same',
    });
    const sup = new HostAgentSupervisor(IDENTITY, { docker });
    await sup.handleCommand({
      id: 'c3',
      type: 'fleet_migrate_box_image',
      payload: migratePayload,
    } as never);

    expect(calls.some((c) => c[0] === 'rm')).toBe(false);
    expect(calls.some((c) => c[0] === 'create')).toBe(false);
  });

  it('a failed rm does NOT create a replacement — never leave the box in neither state', async () => {
    // A create with the old container still present fails on the name clash,
    // and the box would end up with no container at all.
    const { docker, calls } = makeMigrateDocker({
      running: 'false',
      containerImageId: 'sha256:old',
      latestImageId: 'sha256:new',
      rmCode: 1,
    });
    const sup = new HostAgentSupervisor(IDENTITY, { docker });
    await sup.handleCommand({
      id: 'c4',
      type: 'fleet_migrate_box_image',
      payload: migratePayload,
    } as never);

    expect(calls.some((c) => c[0] === 'create')).toBe(false);
  });

  // fleet-1, 2026-09-07 00:00–03:02Z: four hourly sweeps logged "already
  // current" for every sleeping box while `:latest` on the host was still the
  // previous release (2.74.6). The pull of the ~7.7 GB image ran under the
  // generic 120 s docker bound, timed out every hour, and the fail-safe `false`
  // read as "current". Docker keeps the layers an interrupted pull already
  // fetched, so the 04:00 sweep finally finished inside the bound and migrated
  // — four hours late, silently. The pull is THE slow step: it gets the same
  // budget the create/wake pulls get, and a failure is a WARN, not "current".
  it('gives the :latest pull the pull-sized budget, not the 120 s generic bound', async () => {
    const seen: Array<{ args: string[]; timeoutMs?: number }> = [];
    const docker: DockerRunner = {
      run: vi.fn(async (args: string[], opts?: { timeoutMs?: number }) => {
        seen.push({ args, timeoutMs: opts?.timeoutMs });
        if (args[0] === 'inspect' && args.includes('{{.State.Running}}')) {
          return { code: 0, stdout: 'false', stderr: '' };
        }
        if (args[0] === 'inspect' && args.includes('{{.Image}}')) {
          return { code: 0, stdout: 'sha256:old', stderr: '' };
        }
        if (args[0] === 'inspect' && args.includes('{{.Id}}')) {
          return { code: 0, stdout: 'sha256:new', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      }),
    };
    const sup = new HostAgentSupervisor(IDENTITY, { docker });
    await sup.handleCommand({
      id: 'c-pull',
      type: 'fleet_migrate_box_image',
      payload: migratePayload,
    } as never);

    const pull = seen.find((c) => c.args[0] === 'pull');
    expect(pull).toBeDefined();
    expect(pull!.timeoutMs).toBeGreaterThanOrEqual(600_000);
  });

  it('a failed :latest pull is logged as a WARN and the box is left alone (never "already current")', async () => {
    const warn = vi.spyOn(log, 'warn');
    const info = vi.spyOn(log, 'info');
    const { docker, calls } = makeMigrateDocker({
      running: 'false',
      containerImageId: 'sha256:old',
      latestImageId: 'sha256:new',
    });
    (docker.run as ReturnType<typeof vi.fn>).mockImplementation(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'pull') return { code: 124, stdout: '', stderr: 'timed out' };
      if (args[0] === 'inspect' && args.includes('{{.State.Running}}')) {
        return { code: 0, stdout: 'false', stderr: '' };
      }
      if (args[0] === 'inspect' && args.includes('{{.Image}}')) {
        return { code: 0, stdout: 'sha256:old', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const sup = new HostAgentSupervisor(IDENTITY, { docker });
    await sup.handleCommand({
      id: 'c-pullfail',
      type: 'fleet_migrate_box_image',
      payload: migratePayload,
    } as never);

    expect(calls.some((c) => c[0] === 'rm')).toBe(false);
    expect(calls.some((c) => c[0] === 'create')).toBe(false);
    expect(warn.mock.calls.some(([, msg]) => /pull.*failed|failed.*pull/i.test(String(msg)))).toBe(true);
    expect(info.mock.calls.some(([, msg]) => /already current/.test(String(msg)))).toBe(false);
    warn.mockRestore();
    info.mockRestore();
  });

  it('rejects a payload carrying an enrollToken — docker never invoked', async () => {
    // A 15-minute credential baked into a container that may not start for days
    // is a terminal 4xx at boot: a box that never comes back. If a future
    // backend starts sending one, this must fail loudly rather than produce it.
    const { docker, calls } = makeDockerMock();
    const sup = new HostAgentSupervisor(IDENTITY, { docker });
    await sup.handleCommand({
      id: 'c5',
      type: 'fleet_migrate_box_image',
      payload: { ...migratePayload, enrollToken: 'should-not-be-here' },
    } as never);
    expect(calls).toHaveLength(0);
  });

  it('rejects a malformed payload (no limits) — docker never invoked', async () => {
    const { docker, calls } = makeDockerMock();
    const sup = new HostAgentSupervisor(IDENTITY, { docker });
    await sup.handleCommand({
      id: 'c6',
      type: 'fleet_migrate_box_image',
      payload: { boxId: 'b', containerName: migratePayload.containerName, apiOrigin: 'https://x' },
    } as never);
    expect(calls).toHaveLength(0);
  });

  it('fleet_start_box issues `docker start <containerName>` (no recreate creds → fast path)', async () => {
    const { docker, calls } = makeDockerMock();
    const sup = new HostAgentSupervisor(IDENTITY, { docker });

    await sup.handleCommand(fleetRefCmd('fleet_start_box'));

    expect(calls).toEqual([['start', 'codeam-box-clu1a2b3c']]);
  });

  // A per-argv docker mock so the wake-recreate image-staleness probe can return
  // different image ids for the container vs the freshly-pulled :latest.
  function makeImageRouterDocker(containerImageId: string, latestImageId: string) {
    const calls: string[][] = [];
    const opts: Array<{ env?: Record<string, string> } | undefined> = [];
    const docker: DockerRunner = {
      run: vi.fn(async (args: string[], runOpts) => {
        calls.push(args);
        opts.push(runOpts as { env?: Record<string, string> } | undefined);
        if (args[0] === 'inspect' && args.includes('{{.Image}}')) {
          return { code: 0, stdout: containerImageId, stderr: '' };
        }
        if (args[0] === 'inspect' && args.includes('{{.Id}}')) {
          return { code: 0, stdout: latestImageId, stderr: '' };
        }
        return { code: 0, stdout: 'newcontainerid', stderr: '' };
      }),
    };
    return { docker, calls, opts };
  }

  const recreateCreds = {
    enrollToken: 'fresh-wake-token',
    apiOrigin: 'https://api.codeagent-mobile.com',
    limits: { memoryMb: 1536, cpus: 1, pidsLimit: 512, diskGb: 5 },
  };

  it('fleet_start_box WITH recreate creds + STALE image → rm + full run (self-heal, volume preserved)', async () => {
    const { docker, calls, opts } = makeImageRouterDocker('sha256:OLD', 'sha256:NEW');
    const sup = new HostAgentSupervisor(IDENTITY, { docker });

    await sup.handleCommand(fleetRefCmd('fleet_start_box', recreateCreds));

    const argv0 = calls.map((c) => c[0]);
    expect(argv0).toContain('pull'); // pulled :latest before comparing
    expect(calls).toContainEqual(['rm', '-f', 'codeam-box-clu1a2b3c']); // rm WITHOUT -v → volume kept
    const run = calls.find((c) => c[0] === 'run');
    expect(run).toBeDefined();
    expect(run).toContain('codeam-box-clu1a2b3c'); // recreated with the same container/volume
    // The fresh enroll token rides opts.env, NEVER argv.
    const runIdx = calls.findIndex((c) => c[0] === 'run');
    expect(opts[runIdx]?.env).toEqual({ CODEAM_ENROLL_TOKEN: 'fresh-wake-token' });
    expect(run).not.toContain('fresh-wake-token');
    // Did NOT just `docker start` the stale container.
    expect(argv0).not.toContain('start');
  });

  it('fleet_start_box WITH recreate creds + CURRENT image → plain `docker start` (no churn)', async () => {
    const { docker, calls } = makeImageRouterDocker('sha256:SAME', 'sha256:SAME');
    const sup = new HostAgentSupervisor(IDENTITY, { docker });

    await sup.handleCommand(fleetRefCmd('fleet_start_box', recreateCreds));

    const argv0 = calls.map((c) => c[0]);
    expect(argv0).toContain('start');
    expect(argv0).not.toContain('rm');
    expect(argv0).not.toContain('run');
  });

  it('fleet_stop_box issues `docker stop <containerName>`', async () => {
    const { docker, calls } = makeDockerMock();
    const sup = new HostAgentSupervisor(IDENTITY, { docker });

    await sup.handleCommand(fleetRefCmd('fleet_stop_box'));

    expect(calls).toEqual([['stop', 'codeam-box-clu1a2b3c']]);
  });

  it('fleet_delete_box issues `docker rm -f <containerName>` and, with removeVolume, `docker volume rm`', async () => {
    const { docker, calls } = makeDockerMock();
    const sup = new HostAgentSupervisor(IDENTITY, { docker });

    await sup.handleCommand(fleetRefCmd('fleet_delete_box', { removeVolume: true }));

    expect(calls).toEqual([
      ['rm', '-f', 'codeam-box-clu1a2b3c'],
      ['volume', 'rm', 'codeam-box-clu1a2b3c'],
    ]);
  });

  it('fleet_delete_box WITHOUT removeVolume does not touch the volume', async () => {
    const { docker, calls } = makeDockerMock();
    const sup = new HostAgentSupervisor(IDENTITY, { docker });

    await sup.handleCommand(fleetRefCmd('fleet_delete_box'));

    expect(calls).toEqual([['rm', '-f', 'codeam-box-clu1a2b3c']]);
  });

  it('rejects a malformed fleet_*_box ref payload (bad containerName)', async () => {
    for (const type of ['fleet_start_box', 'fleet_stop_box', 'fleet_delete_box']) {
      const { docker, calls } = makeDockerMock();
      const sup = new HostAgentSupervisor(IDENTITY, { docker });
      await sup.handleCommand(fleetRefCmd(type, { containerName: 'evil-name' }));
      expect(calls).toHaveLength(0);
    }
  });

  it('fleet_stop_box is idempotent — "No such container" is treated as success (no warn)', async () => {
    const { docker } = makeDockerMock({ code: 1, stderr: 'Error: No such container: codeam-box-clu1a2b3c' });
    const sup = new HostAgentSupervisor(IDENTITY, { docker });
    const warnSpy = vi.spyOn(log, 'warn');

    await sup.handleCommand(fleetRefCmd('fleet_stop_box'));

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('fleet_delete_box is idempotent — "No such container"/"No such volume" are success (no warn)', async () => {
    const docker: DockerRunner = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === 'rm') {
          return { code: 1, stdout: '', stderr: 'Error: No such container: codeam-box-clu1a2b3c' };
        }
        return { code: 1, stdout: '', stderr: 'Error: No such volume: codeam-box-clu1a2b3c' };
      }),
    };
    const sup = new HostAgentSupervisor(IDENTITY, { docker });
    const warnSpy = vi.spyOn(log, 'warn');

    await sup.handleCommand(fleetRefCmd('fleet_delete_box', { removeVolume: true }));

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('a REAL fleet_stop_box failure (not idempotent) IS logged as a warning', async () => {
    const { docker } = makeDockerMock({ code: 1, stderr: 'Error: some other docker failure' });
    const sup = new HostAgentSupervisor(IDENTITY, { docker });
    const warnSpy = vi.spyOn(log, 'warn');

    await sup.handleCommand(fleetRefCmd('fleet_stop_box'));

    expect(warnSpy).toHaveBeenCalled();
  });

  it('the enroll token never appears in any log call across the fleet_create_box path', async () => {
    const { docker } = makeDockerMock();
    const sup = new HostAgentSupervisor(IDENTITY, { docker });
    const infoSpy = vi.spyOn(log, 'info');
    const warnSpy = vi.spyOn(log, 'warn');
    const traceSpy = vi.spyOn(log, 'trace');

    const secret = 'super-secret-enroll-token';
    await sup.handleCommand(fleetCreateCmd({ enrollToken: secret }));

    const allLoggedArgs = [...infoSpy.mock.calls, ...warnSpy.mock.calls, ...traceSpy.mock.calls]
      .flat()
      .map((v) => String(v));
    for (const line of allLoggedArgs) {
      expect(line).not.toContain(secret);
    }
  });

  // ── Host disk housekeeping (2026-08-21) ─────────────────────────────────
  // The shared VPS filled to 83% (160 GB of 193) because nothing reclaimed
  // Docker's residue — `/var/lib/containerd` alone was 138 GB, since every
  // `docker run --pull=always` of a new `codeam-box:latest` orphans the previous
  // image. One prune freed 93.8 GB. A full disk takes down every rescued box AND
  // the co-located 24/7 session.
  //
  // These tests exist for the SCOPE, which is the dangerous part: this handler
  // runs as root on a host holding every rescued user's data.
  it('fleet_prune_host prunes dangling images and the build cache', async () => {
    const { docker, calls } = makeDockerMock({ stdout: 'Total reclaimed space: 93.8GB' });
    const sup = new HostAgentSupervisor(IDENTITY, { docker });

    await sup.handleCommand(fleetPruneCmd());

    expect(calls).toEqual([
      ['image', 'prune', '-f'],
      ['builder', 'prune', '-f'],
    ]);
  });

  it('NEVER prunes containers or volumes — a stopped fleet container is a sleeping box', async () => {
    const { docker, calls } = makeDockerMock();
    const sup = new HostAgentSupervisor(IDENTITY, { docker });

    // Even if the wire tries to widen the scope, the handler must not comply.
    await sup.handleCommand(
      fleetPruneCmd({ containers: true, volumes: true, all: true }),
    );

    const flat = calls.map((c) => c.join(' '));
    expect(flat).not.toContain('container prune -f');
    expect(flat).not.toContain('volume prune -f');
    expect(flat).not.toContain('system prune -f');
    // `-a` would delete images no RUNNING container uses, which includes the
    // image a SLEEPING box needs to be recreated from.
    for (const c of calls) expect(c).not.toContain('-a');
    for (const c of calls) expect(c[0]).not.toBe('container');
    for (const c of calls) expect(c[0]).not.toBe('volume');
    for (const c of calls) expect(c[0]).not.toBe('system');
  });

  it('honours the flags — buildCache:false prunes images only', async () => {
    const { docker, calls } = makeDockerMock();
    const sup = new HostAgentSupervisor(IDENTITY, { docker });
    await sup.handleCommand(fleetPruneCmd({ buildCache: false }));
    expect(calls).toEqual([['image', 'prune', '-f']]);
  });

  it('a failing prune step does not stop the next one (best-effort housekeeping)', async () => {
    const { docker, calls } = makeDockerMock({ code: 1, stderr: 'daemon not reachable' });
    const sup = new HostAgentSupervisor(IDENTITY, { docker });
    await expect(sup.handleCommand(fleetPruneCmd())).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it('ignores a malformed fleet_prune_host instead of running docker', async () => {
    const { docker, calls } = makeDockerMock();
    const sup = new HostAgentSupervisor(IDENTITY, { docker });
    await sup.handleCommand({
      id: 'cmd-bad',
      sessionId: 'sh-plugin-1',
      type: 'fleet_prune_host',
      payload: { images: 'yes' },
    } as unknown as RemoteCommand);
    expect(calls).toEqual([]);
  });

});

// ───────────────────────────────────────────────────────────────────────────
// codeagent-v07a — after `systemctl restart codeam-host-agent` only the LAST
// active session came back (live 2026-09-23). Root cause: the boot resume read
// `getActiveSession()` — the CLI config's single "last paired" pointer — and
// spawned ONE child. The supervisor now mirrors its live children to a
// persisted set and resumes ALL of them on boot (bounded, newest first), each
// child pinned to its own session; sessions beyond the bound get an explicit
// `ended { reason: 'host_restart' }` instead of a dead card.
// ───────────────────────────────────────────────────────────────────────────
describe('HostAgentSupervisor — multi-session boot resume (codeagent-v07a)', () => {
  type Rec = import('../src/commands/host/session-state').PersistedSessionChild;

  function memoryStore(initial: Rec[] = []) {
    let list: Rec[] = [...initial];
    const saves: Rec[][] = [];
    return {
      store: {
        load: () => [...list],
        save: (next: Rec[]) => {
          list = [...next];
          saves.push([...next]);
        },
        clear: () => {
          list = [];
          saves.push([]);
        },
      },
      saves,
      current: () => list,
    };
  }

  function fakeProc() {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    return proc;
  }

  const saved = (id: string, cwd: string, pairedAt = 0) => ({
    id,
    pluginId: `plug-${id}`,
    pollSecret: 'sec',
    pluginAuthToken: `auth-${id}`,
    agent: 'claude',
    userName: 'u',
    userEmail: 'e',
    plan: 'pro',
    pairedAt,
    cwd,
  });

  let tmpRoot: string;
  let prevMax: string | undefined;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v07a-'));
    prevMax = process.env.CODEAM_HOST_MAX_RESUME_SESSIONS;
    delete process.env.CODEAM_HOST_MAX_RESUME_SESSIONS;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, data: {} }) }),
    );
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    if (prevMax === undefined) delete process.env.CODEAM_HOST_MAX_RESUME_SESSIONS;
    else process.env.CODEAM_HOST_MAX_RESUME_SESSIONS = prevMax;
  });

  function ws(deployId: string): string {
    const dir = path.join(tmpRoot, deployId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function sessionEventBodies(): Array<Record<string, unknown>> {
    const f = fetch as unknown as ReturnType<typeof vi.fn>;
    return f.mock.calls
      .filter((c) => String(c[0]).endsWith('/api/self-hosted/session-event'))
      .map((c) => JSON.parse((c[1] as { body: string }).body) as Record<string, unknown>);
  }

  it('resumes EVERY persisted session (not just the last active one), each pinned to its own session', () => {
    const a = ws('dep-a');
    const b = ws('dep-b');
    const { store } = memoryStore([
      { deployId: 'dep-a', cwd: a, agent: 'claude', startedAt: 1_000 },
      { deployId: 'dep-b', cwd: b, agent: 'claude', startedAt: 2_000 },
    ]);
    const procs: ReturnType<typeof fakeProc>[] = [];
    const resumeSpawner = vi.fn(() => {
      const p = fakeProc();
      procs.push(p);
      return p as never;
    });
    const sup = new HostAgentSupervisor(IDENTITY, {
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn(), sendResult: vi.fn() }),
      resumeSpawner,
      sessionStore: store,
      listSavedSessions: () => [saved('sess-a', a, 1), saved('sess-b', b, 2)] as never,
    });
    sup.start();
    try {
      expect(resumeSpawner).toHaveBeenCalledTimes(2);
      const calls = resumeSpawner.mock.calls as unknown as Array<[Record<string, string>, string]>;
      // Newest first, and each child carries ITS session id (the pin) + its cwd.
      expect(calls.map((c) => c[1])).toEqual([b, a]);
      expect(calls.map((c) => c[0].CODEAM_RESUME_SESSION_ID)).toEqual(['sess-b', 'sess-a']);
      // Both children are live for the boot reconcile.
      const reconcile = sessionEventBodies().find((e) => e.event === 'reconcile');
      expect(reconcile?.activeDeployIds).toEqual(expect.arrayContaining(['dep-a', 'dep-b']));
      expect(store.load().map((r) => r.deployId).sort()).toEqual(['dep-a', 'dep-b']);
    } finally {
      sup.stop();
    }
  });

  it('bounds the resume (default 3, env override) and ENDS the oldest beyond it with reason host_restart', () => {
    process.env.CODEAM_HOST_MAX_RESUME_SESSIONS = '2';
    const dirs = ['d1', 'd2', 'd3', 'd4'].map((d) => ws(d));
    const { store } = memoryStore(
      dirs.map((cwd, i) => ({ deployId: `d${i + 1}`, cwd, agent: 'claude', startedAt: (i + 1) * 1_000 })),
    );
    const resumeSpawner = vi.fn(() => fakeProc() as never);
    const sup = new HostAgentSupervisor(IDENTITY, {
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn(), sendResult: vi.fn() }),
      resumeSpawner,
      sessionStore: store,
      listSavedSessions: () => dirs.map((cwd, i) => saved(`s${i + 1}`, cwd)) as never,
    });
    sup.start();
    try {
      expect(resumeSpawner).toHaveBeenCalledTimes(2);
      const pinned = (resumeSpawner.mock.calls as unknown as Array<[Record<string, string>, string]>).map(
        (c) => c[0].CODEAM_RESUME_SESSION_ID,
      );
      expect(pinned).toEqual(['s4', 's3']); // the two newest
      const ended = sessionEventBodies().filter((e) => e.event === 'ended');
      expect(ended.map((e) => e.deployId).sort()).toEqual(['d1', 'd2']);
      for (const e of ended) expect(e.reason).toBe('host_restart');
      // The persisted set now holds only the live two.
      expect(store.load().map((r) => r.deployId).sort()).toEqual(['d3', 'd4']);
    } finally {
      sup.stop();
    }
  });

  it('skips a persisted child whose session was deleted from the app, without touching the others', () => {
    const a = ws('dep-a');
    const b = ws('dep-b');
    const { store } = memoryStore([
      { deployId: 'dep-a', cwd: a, agent: 'claude', startedAt: 1 },
      { deployId: 'dep-b', cwd: b, agent: 'claude', startedAt: 2 },
    ]);
    const resumeSpawner = vi.fn(() => fakeProc() as never);
    const sup = new HostAgentSupervisor(IDENTITY, {
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn(), sendResult: vi.fn() }),
      resumeSpawner,
      sessionStore: store,
      listSavedSessions: () => [saved('sess-b', b)] as never, // sess-a gone
    });
    sup.start();
    try {
      expect(resumeSpawner).toHaveBeenCalledTimes(1);
      expect((resumeSpawner.mock.calls[0] as unknown as [Record<string, string>])[0].CODEAM_RESUME_SESSION_ID).toBe('sess-b');
      expect(store.load().map((r) => r.deployId)).toEqual(['dep-b']);
    } finally {
      sup.stop();
    }
  });

  it('falls back to the single last-active session when nothing is persisted (pre-upgrade restart)', async () => {
    const config = await import('../src/config');
    const a = ws('dep-a');
    vi.mocked(config.getActiveSession).mockReturnValueOnce(saved('sess-a', a) as never);
    const { store } = memoryStore([]);
    const resumeSpawner = vi.fn(() => fakeProc() as never);
    const sup = new HostAgentSupervisor(IDENTITY, {
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn(), sendResult: vi.fn() }),
      resumeSpawner,
      sessionStore: store,
      listSavedSessions: () => [],
    });
    sup.start();
    try {
      expect(resumeSpawner).toHaveBeenCalledTimes(1);
      expect((resumeSpawner.mock.calls[0] as unknown as [Record<string, string>])[0].CODEAM_RESUME_SESSION_ID).toBe('sess-a');
      // From now on the set IS persisted, so the next restart resumes it from the
      // file. The key is `deployIdFromWorkspace(cwd) ?? session.id` (unchanged
      // rule) — a cwd outside ~/.codeam/self-hosted/ falls back to the session id.
      expect(store.load()).toEqual([expect.objectContaining({ deployId: 'sess-a', cwd: a })]);
    } finally {
      sup.stop();
    }
  });

  it('persists on child add/exit but NOT on stop(): the set survives a graceful restart', () => {
    const a = ws('dep-a');
    const b = ws('dep-b');
    const { store, saves } = memoryStore([
      { deployId: 'dep-a', cwd: a, agent: 'claude', startedAt: 1 },
      { deployId: 'dep-b', cwd: b, agent: 'claude', startedAt: 2 },
    ]);
    const procs: ReturnType<typeof fakeProc>[] = [];
    const resumeSpawner = vi.fn(() => {
      const p = fakeProc();
      procs.push(p);
      return p as never;
    });
    const sup = new HostAgentSupervisor(IDENTITY, {
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn(), sendResult: vi.fn() }),
      resumeSpawner,
      sessionStore: store,
      listSavedSessions: () => [saved('sess-a', a), saved('sess-b', b)] as never,
    });
    sup.start();
    expect(store.load()).toHaveLength(2);
    // The app stopped session A → its child exits cleanly → dropped from the set.
    procs[1].emit('exit', 0, null); // procs[1] is dep-a (spawned second: newest first)
    expect(store.load().map((r) => r.deployId)).toEqual(['dep-b']);
    const savesBeforeStop = saves.length;
    // systemctl restart → stop() kills B but must NOT rewrite the set.
    sup.stop();
    expect(saves.length).toBe(savesBeforeStop);
    expect(store.load().map((r) => r.deployId)).toEqual(['dep-b']);
  });

  it('keeps per-session retry budgets: one session crash-looping does not spend the other\'s', () => {
    vi.useFakeTimers();
    try {
      const a = ws('dep-a');
      const b = ws('dep-b');
      const { store } = memoryStore([
        { deployId: 'dep-a', cwd: a, agent: 'claude', startedAt: 1 },
        { deployId: 'dep-b', cwd: b, agent: 'claude', startedAt: 2 },
      ]);
      const spawned: Array<{ id: string; proc: ReturnType<typeof fakeProc> }> = [];
      const resumeSpawner = vi.fn((env: Record<string, string>) => {
        const p = fakeProc();
        spawned.push({ id: env.CODEAM_RESUME_SESSION_ID, proc: p });
        return p as never;
      });
      const postResumeFailure = vi.fn(async () => undefined);
      const prev = process.env.CODEAM_HOST_SELF_UPDATE_MS;
      process.env.CODEAM_HOST_SELF_UPDATE_MS = '0';
      const sup = new HostAgentSupervisor(IDENTITY, {
        makeRelay: () => ({ start: vi.fn(), stop: vi.fn(), sendResult: vi.fn() }),
        resumeSpawner,
        postResumeFailure,
        sessionStore: store,
        listSavedSessions: () => [saved('sess-a', a), saved('sess-b', b)] as never,
      });
      sup.start();
      try {
        // A dies every time; B stays up.
        const dieA = () => {
          const last = [...spawned].reverse().find((s) => s.id === 'sess-a');
          last?.proc.emit('exit', 1, null);
        };
        for (let i = 0; i <= RESUME_RETRY_BACKOFF_MS.length; i++) {
          dieA();
          vi.advanceTimersByTime(RESUME_RETRY_BACKOFF_MS[Math.min(i, RESUME_RETRY_BACKOFF_MS.length - 1)]);
        }
        const aSpawns = spawned.filter((s) => s.id === 'sess-a').length;
        const bSpawns = spawned.filter((s) => s.id === 'sess-b').length;
        expect(aSpawns).toBe(RESUME_RETRY_BACKOFF_MS.length + 1); // initial + every retry
        expect(bSpawns).toBe(1); // untouched
        expect(postResumeFailure).toHaveBeenCalledTimes(1);
        expect((postResumeFailure.mock.calls[0] as unknown as [{ sessionId: string }])[0].sessionId).toBe('sess-a');
        // B is still tracked; A is gone from the live set.
        expect(store.load().map((r) => r.deployId)).toEqual(['dep-b']);
      } finally {
        sup.stop();
        if (prev === undefined) delete process.env.CODEAM_HOST_SELF_UPDATE_MS;
        else process.env.CODEAM_HOST_SELF_UPDATE_MS = prev;
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
