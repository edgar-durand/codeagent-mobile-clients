import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { AgentAuth, AgentMetadata } from '@codeagent/shared';

import {
  HostAgentSupervisor,
  resolveHostIdentity,
  type ChildSpawner,
} from '../src/commands/host-agent';
import { hostEnroll } from '../src/commands/host';
import {
  hostIdentityPath,
  loadHostIdentity,
  MetricsCollector,
  reportProgress,
  sendHostHeartbeat,
  type SealedHostIdentity,
} from '../src/commands/host/host-client';
import type { RemoteCommand } from '../src/services/command-relay.service';

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

    // 2) Sealed to ~/.codeam/host-agent.json at mode 0600.
    const file = hostIdentityPath();
    expect(fs.existsSync(file)).toBe(true);
    // POSIX file modes don't apply on Windows (the host-agent is a Linux/systemd
    // feature); skip the 0600 assertion there.
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(loadHostIdentity()).toEqual({
      hostId: 'h1',
      hostToken: 'long-lived',
      controlPluginId: 'sh-cp',
    });

    // 3) Idempotent — a second enroll does NOT re-redeem.
    await hostEnroll(['--token=ENROLL']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

    // The fresh token wins — the stale identity is replaced, not reused.
    expect(resolved).toEqual(fresh);
    expect(loadHostIdentity()).toEqual(fresh);
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

  it('rethrows when redeem fails AND there is no sealed identity to fall back to', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/api/self-hosted/redeem')) {
        return {
          ok: false,
          status: 410,
          statusText: 'Gone',
          json: async () => ({ success: false, error: { code: 'TOKEN_EXPIRED' } }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveHostIdentity('EXPIRED-TOKEN')).rejects.toThrow(/redeem failed/);
  });

  it('returns null when neither identity nor token is available', async () => {
    expect(await resolveHostIdentity(undefined)).toBeNull();
  });
});

describe('HostAgentSupervisor — control channel reuse', () => {
  it('subscribes via the relay (not a new poller) on the controlPluginId', () => {
    const start = vi.fn();
    const stop = vi.fn();
    let capturedPluginId = '';
    let capturedMeta: AgentMetadata | null = null;
    const makeRelay = (
      pluginId: string,
      _onCommand: (cmd: RemoteCommand) => void | Promise<void>,
      meta: AgentMetadata,
    ) => {
      capturedPluginId = pluginId;
      capturedMeta = meta;
      return { start, stop };
    };

    const sup = new HostAgentSupervisor(IDENTITY, {
      makeRelay,
      // Heartbeat would hit the network — stub fetch to a no-op success.
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, data: { ok: true } }) }),
    );
    sup.start();

    // The relay (the existing SSE-pull command-relay) is the control
    // channel — opened on the host's controlPluginId. No separate poller.
    expect(start).toHaveBeenCalledTimes(1);
    expect(capturedPluginId).toBe(IDENTITY.controlPluginId);
    expect(capturedMeta).not.toBeNull();

    sup.stop();
    expect(stop).toHaveBeenCalledTimes(1);
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
    expect(calls[0].cwd).toBe(cwdTarget);
    expect(sup.childCount()).toBe(1);

    // Credential was written the codespace way: ~/.claude/.credentials.json (0600).
    const credFile = path.join(tmpHome, '.claude', '.credentials.json');
    expect(fs.existsSync(credFile)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(credFile).mode & 0o777).toBe(0o600);
    }

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
    expect(calls[0].args).toEqual(['--agent=claude']);
    expect(sup.childCount()).toBe(1);

    // No cred files written for the house agent.
    const credFile = path.join(tmpHome, '.claude', '.credentials.json');
    expect(fs.existsSync(credFile)).toBe(false);

    fs.rmSync(cwdTarget, { recursive: true, force: true });
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

    const sup = new HostAgentSupervisor(IDENTITY, { makeRelay: () => ({ start: vi.fn(), stop: vi.fn() }) });
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
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn() }),
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
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn() }),
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
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn() }),
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
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn() }),
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
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn() }),
      onIdentityRejected,
    });
    sup.start();
    await flushBeat();
    sup.stop();

    expect(onIdentityRejected).not.toHaveBeenCalled();
    expect(fs.existsSync(hostIdentityPath())).toBe(true);
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
      makeRelay: () => ({ start: vi.fn(), stop: relayStop }),
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
