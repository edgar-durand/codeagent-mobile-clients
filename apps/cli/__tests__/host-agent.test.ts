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
  reportProgress,
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

describe('resolveHostIdentity', () => {
  it('returns the sealed identity without redeeming when present', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fs.mkdirSync(path.dirname(hostIdentityPath()), { recursive: true });
    fs.writeFileSync(hostIdentityPath(), JSON.stringify(IDENTITY));

    const resolved = await resolveHostIdentity(undefined);
    expect(resolved).toEqual(IDENTITY);
    expect(fetchMock).not.toHaveBeenCalled();
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
