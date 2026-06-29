import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { AgentAuth, AgentMetadata } from '@codeagent/shared';
import { isOwnerOnly } from '../src/util/restrict-to-owner';

import {
  HostAgentSupervisor,
  resolveHostIdentity,
  type ChildSpawner,
  setupHeadroomForSelfHosted,
  resolveHeadroomPython,
  ensureModernPython,
  getFreeDiskBytes,
  agentIdToHeadroomKind,
  isHeadroomSupportedAgent,
  detectPackageManager,
  readHeadroomChildEnv,
  headroomConfigPath,
  persistHeadroomConfig,
  maybeResumeLocalHeadroomReporter,
  type HeadroomRunner,
  type SelfUpdateResult,
} from '../src/commands/host-agent';
import { hostEnroll } from '../src/commands/host';
import {
  hostIdentityPath,
  loadHostIdentity,
  MetricsCollector,
  reportProgress,
  reportSessionEvent,
  sendHostHeartbeat,
  type SealedHostIdentity,
} from '../src/commands/host/host-client';
import type { RemoteCommand } from '../src/services/command-relay.service';

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

    // 2) Sealed to ~/.codeam/host-agent.json at mode 0600.
    const file = hostIdentityPath();
    expect(fs.existsSync(file)).toBe(true);
    expect(isOwnerOnly(file)).toBe(true);
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

    // REGRESSION GUARD (self-hosted house-agent 401): the house agent is
    // Claude Code wired to the managed proxy via ANTHROPIC_AUTH_TOKEN. On a
    // REUSED self-hosted box, Claude's on-disk OAuth identity
    // (~/.claude/.credentials.json + ~/.claude.json) takes precedence over the
    // ANTHROPIC_AUTH_TOKEN gateway, so the box owner's stale personal login
    // wins and the proxy returns 401. The fix isolates the house agent's Claude
    // config into its own dir (CLAUDE_CONFIG_DIR) so it can NEVER read the box
    // owner's personal credentials. Without this env var the house deploy
    // regresses to a 401 on any box that already has a personal `claude` login.
    const houseConfigDir = path.join(tmpHome, '.codeam', 'house-claude');
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
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn() }),
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
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn() }),
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
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn() }),
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
    const teardownHeadroom = vi.fn();
    const onIdentityRejected = vi.fn(() => {
      fs.rmSync(hostIdentityPath(), { force: true });
    });

    const sup = new HostAgentSupervisor(IDENTITY, {
      makeRelay: () => ({ start: vi.fn(), stop: relayStop }),
      disableService,
      teardownHeadroom,
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
    expect(teardownHeadroom).toHaveBeenCalledTimes(1); // per-host proxy reaped
    expect(disableService).toHaveBeenCalledTimes(1);
    expect(onIdentityRejected).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(hostIdentityPath())).toBe(false);
  });

  it('does NOT tear down the Headroom proxy on a per-session self_hosted_stop (shared singleton)', async () => {
    // No start() — the self_hosted_stop path goes straight through
    // handleCommand → stopChild and needs neither the relay nor the
    // heartbeat/self-update timers. Starting them here and not stopping the
    // supervisor leaks a heartbeat timer that fires during a later test and
    // trips the default onIdentityRejected → process.exit(1).
    const teardownHeadroom = vi.fn();
    const sup = new HostAgentSupervisor(IDENTITY, {
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn() }),
      teardownHeadroom,
    });

    await sup.handleCommand({
      id: 'cmd-stop',
      sessionId: 'sh-plugin-1',
      type: 'self_hosted_stop',
      payload: { sessionId: 'sh-plugin-1' },
    });

    // The proxy is shared across sessions on the box — a single session stop
    // must NOT reap it (only a full self_hosted_wipe does).
    expect(teardownHeadroom).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Headroom — payload validator back-compat + env injection
// ─────────────────────────────────────────────────────────────────────────────

describe('isDeployPayload — headroom fields back-compat', () => {
  /**
   * Drive the validator indirectly: feed a `self_hosted_deploy` command to
   * `handleCommand` and observe whether a child is spawned (validator passed)
   * or not (validator rejected). We inject a no-op resolveAgentAuth so no real
   * network call occurs, and point repoOrPath at a real tmp directory so
   * prepareWorkspace doesn't throw.
   */
  async function assertValidatorAccepts(
    overrides: Record<string, unknown>,
  ): Promise<Record<string, string>> {
    const cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-hr-'));
    const calls: Array<{ env: Record<string, string> }> = [];
    const spawnChild: ChildSpawner = (env) => {
      calls.push({ env });
      return fakeChild();
    };
    const resolveAgentAuth = vi
      .fn<(i: SealedHostIdentity, s: string) => Promise<AgentAuth>>()
      .mockResolvedValue({ kind: 'oauth_token', value: '{"claudeAiOauth":{}}' });
    // setupHeadroom is mocked to succeed so the headroom env injection branch
    // is exercised without real pip.
    const setupHeadroom = vi.fn<(a: string) => Promise<boolean>>().mockResolvedValue(true);
    const sup = new HostAgentSupervisor(IDENTITY, { spawnChild, resolveAgentAuth, setupHeadroom });

    await sup.handleCommand(deployCmd({ repoOrPath: cwdTarget, ...overrides }));

    fs.rmSync(cwdTarget, { recursive: true, force: true });
    return calls[0]?.env ?? {};
  }

  it('accepts a payload with NO headroom fields (older backend — back-compat)', async () => {
    const env = await assertValidatorAccepts({});
    // No headroom env on the child — older payload treated as disabled.
    expect(env.HEADROOM_ENABLED).toBeUndefined();
    expect(env.HEADROOM_AGENT).toBeUndefined();
    expect(env.HEADROOM_SAVINGS_INGEST_URL).toBeUndefined();
  });

  it('accepts a payload with headroomEnabled=false (feature explicitly off)', async () => {
    const env = await assertValidatorAccepts({ headroomEnabled: false });
    expect(env.HEADROOM_ENABLED).toBeUndefined();
  });

  it('accepts a payload with all 3 headroom fields present and valid', async () => {
    const env = await assertValidatorAccepts({
      headroomEnabled: true,
      headroomAgent: 'claude',
      headroomSavingsIngestUrl: 'https://api.codeagent.test/headroom-savings',
    });
    // All 3 HEADROOM_* vars injected because setupHeadroom mock returns true.
    expect(env.HEADROOM_ENABLED).toBe('1');
    expect(env.HEADROOM_AGENT).toBe('claude');
    expect(env.HEADROOM_SAVINGS_INGEST_URL).toBe('https://api.codeagent.test/headroom-savings');
  });

  it('rejects a malformed headroomEnabled (wrong type)', async () => {
    const spawnChild = vi.fn<ChildSpawner>(() => fakeChild());
    const resolveAgentAuth = vi
      .fn<(i: SealedHostIdentity, s: string) => Promise<AgentAuth>>()
      .mockResolvedValue({ kind: 'oauth_token', value: '{}' });
    const sup = new HostAgentSupervisor(IDENTITY, { spawnChild, resolveAgentAuth });

    await sup.handleCommand(
      deployCmd({ headroomEnabled: 'yes' }), // should be boolean
    );

    // Validator rejected the payload → no child spawned.
    expect(spawnChild).not.toHaveBeenCalled();
  });

  it('rejects a malformed headroomAgent (wrong type)', async () => {
    const spawnChild = vi.fn<ChildSpawner>(() => fakeChild());
    const resolveAgentAuth = vi
      .fn<(i: SealedHostIdentity, s: string) => Promise<AgentAuth>>()
      .mockResolvedValue({ kind: 'oauth_token', value: '{}' });
    const sup = new HostAgentSupervisor(IDENTITY, { spawnChild, resolveAgentAuth });

    await sup.handleCommand(
      deployCmd({ headroomEnabled: true, headroomAgent: 42 }), // agent must be a string
    );

    expect(spawnChild).not.toHaveBeenCalled();
  });

  it('rejects a malformed headroomSavingsIngestUrl (wrong type)', async () => {
    const spawnChild = vi.fn<ChildSpawner>(() => fakeChild());
    const resolveAgentAuth = vi
      .fn<(i: SealedHostIdentity, s: string) => Promise<AgentAuth>>()
      .mockResolvedValue({ kind: 'oauth_token', value: '{}' });
    const sup = new HostAgentSupervisor(IDENTITY, { spawnChild, resolveAgentAuth });

    await sup.handleCommand(
      deployCmd({ headroomEnabled: true, headroomAgent: 'claude', headroomSavingsIngestUrl: 99 }),
    );

    expect(spawnChild).not.toHaveBeenCalled();
  });
});

describe('agentIdToHeadroomKind', () => {
  it('maps claude / claude_code / claude-code → claude', () => {
    expect(agentIdToHeadroomKind('claude')).toBe('claude');
    expect(agentIdToHeadroomKind('claude_code')).toBe('claude');
    expect(agentIdToHeadroomKind('claude-code')).toBe('claude');
    expect(agentIdToHeadroomKind('Claude_Code')).toBe('claude'); // case-insensitive
  });

  it('maps codex / codex_cli → codex', () => {
    expect(agentIdToHeadroomKind('codex')).toBe('codex');
    expect(agentIdToHeadroomKind('codex_cli')).toBe('codex');
  });

  it('maps copilot → copilot', () => {
    expect(agentIdToHeadroomKind('copilot')).toBe('copilot');
    expect(agentIdToHeadroomKind('copilot-cli')).toBe('copilot');
  });

  it('defaults unknown / empty ids to claude (safe default)', () => {
    expect(agentIdToHeadroomKind('something_else')).toBe('claude');
    expect(agentIdToHeadroomKind('')).toBe('claude');
    // Defensive: an undefined slipping through must not crash.
    expect(agentIdToHeadroomKind(undefined as unknown as string)).toBe('claude');
  });
});

describe('isHeadroomSupportedAgent', () => {
  it('returns true for Headroom-wrappable agents', () => {
    expect(isHeadroomSupportedAgent('claude_code')).toBe(true);
    expect(isHeadroomSupportedAgent('codex')).toBe(true);
    expect(isHeadroomSupportedAgent('copilot')).toBe(true);
  });

  it('returns false for agents Headroom cannot wrap (must run native, NOT mislaunch as claude)', () => {
    // Regression: gemini/cursor mapped to claude via the kind default → mislaunched.
    // cursor: `headroom wrap cursor` is manual/print-only (Cursor IDE settings),
    // not a launcher for the headless cursor-agent CLI → run native (over ACP).
    expect(isHeadroomSupportedAgent('cursor')).toBe(false);
    expect(isHeadroomSupportedAgent('gemini')).toBe(false);
    expect(isHeadroomSupportedAgent('aider')).toBe(false);
    expect(isHeadroomSupportedAgent('coderabbit')).toBe(false);
    expect(isHeadroomSupportedAgent('')).toBe(false);
    expect(isHeadroomSupportedAgent(undefined as unknown as string)).toBe(false);
  });
});

describe('HostAgentSupervisor — Headroom env injection', () => {
  function makeHeadroomSupervisor(
    setupHeadroomResult: boolean,
    overrides: {
      isHeadroomInstalled?: () => boolean;
      getFreeDisk?: (dir: string) => Promise<number | null>;
    } = {},
  ) {
    const setupHeadroom = vi
      .fn<(a: string) => Promise<boolean>>()
      .mockResolvedValue(setupHeadroomResult);
    const resolveAgentAuth = vi
      .fn<(i: SealedHostIdentity, s: string) => Promise<AgentAuth>>()
      .mockResolvedValue({ kind: 'oauth_token', value: '{"claudeAiOauth":{}}' });
    const calls: Array<{ env: Record<string, string>; cwd: string }> = [];
    const spawnChild: ChildSpawner = (env, cwd) => {
      calls.push({ env, cwd });
      return fakeChildWithStreams();
    };
    const sup = new HostAgentSupervisor(IDENTITY, {
      spawnChild,
      resolveAgentAuth,
      setupHeadroom,
      ...overrides,
    });
    return { sup, setupHeadroom, calls };
  }

  /** 1 GB — below the 2 GB install gate. */
  const LOW_DISK_BYTES = 1 * 1024 * 1024 * 1024;

  it('bypasses the install disk gate when Headroom is already installed (low disk still reports)', async () => {
    const cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-hr-'));
    // Disk is BELOW the gate, but Headroom is already installed → setup should
    // still run (idempotent) and the child should carry the HEADROOM_* env so
    // savings keep being reported. This is the regression: a 2.0 GB box that was
    // already compressing got reporting silently disabled.
    const { sup, setupHeadroom, calls } = makeHeadroomSupervisor(true, {
      isHeadroomInstalled: () => true,
      getFreeDisk: async () => LOW_DISK_BYTES,
    });

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

    await sup.handleCommand(
      deployCmd({
        repoOrPath: cwdTarget,
        headroomEnabled: true,
        headroomAgent: 'claude',
        headroomSavingsIngestUrl: 'https://ingest.test/savings',
      }),
    );

    expect(setupHeadroom).toHaveBeenCalledWith('claude');
    expect(calls).toHaveLength(1);
    expect(calls[0].env.HEADROOM_ENABLED).toBe('1');
    expect(calls[0].env.HEADROOM_SAVINGS_INGEST_URL).toBe('https://ingest.test/savings');

    fs.rmSync(cwdTarget, { recursive: true, force: true });
  });

  it('honors the disk gate (skips setup) when Headroom is NOT already installed and disk is low', async () => {
    const cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-hr-'));
    const { sup, setupHeadroom, calls } = makeHeadroomSupervisor(true, {
      isHeadroomInstalled: () => false,
      getFreeDisk: async () => LOW_DISK_BYTES,
    });

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

    await sup.handleCommand(
      deployCmd({
        repoOrPath: cwdTarget,
        headroomEnabled: true,
        headroomAgent: 'claude',
        headroomSavingsIngestUrl: 'https://ingest.test/savings',
      }),
    );

    // Install skipped → setupHeadroom never called, no HEADROOM_* env injected.
    expect(setupHeadroom).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0].env.HEADROOM_ENABLED).toBeUndefined();

    fs.rmSync(cwdTarget, { recursive: true, force: true });
  });

  it('injects HEADROOM_* env vars into the child when headroomEnabled=true and setup succeeds', async () => {
    const cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-hr-'));
    const { sup, setupHeadroom, calls } = makeHeadroomSupervisor(true);

    // Stub fetch for the deploy-progress best-effort POSTs.
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

    await sup.handleCommand(
      deployCmd({
        repoOrPath: cwdTarget,
        headroomEnabled: true,
        headroomAgent: 'claude',
        headroomSavingsIngestUrl: 'https://ingest.test/savings',
      }),
    );

    // setupHeadroom called with the right agent.
    expect(setupHeadroom).toHaveBeenCalledWith('claude');

    // Child env carries all 3 headroom vars.
    expect(calls).toHaveLength(1);
    expect(calls[0].env.HEADROOM_ENABLED).toBe('1');
    expect(calls[0].env.HEADROOM_AGENT).toBe('claude');
    expect(calls[0].env.HEADROOM_SAVINGS_INGEST_URL).toBe('https://ingest.test/savings');

    // Standard deploy env vars still present (never-break check).
    expect(calls[0].env.CODEAM_AUTO_TOKEN).toBe('auto-xyz');

    fs.rmSync(cwdTarget, { recursive: true, force: true });
  });

  it('maps a raw LinkedAgentId (claude_code) to the headroom kind (claude) in HEADROOM_AGENT', async () => {
    const cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-hr-'));
    const { sup, setupHeadroom, calls } = makeHeadroomSupervisor(true);

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

    await sup.handleCommand(
      deployCmd({
        repoOrPath: cwdTarget,
        headroomEnabled: true,
        headroomAgent: 'claude_code', // the real self-hosted LinkedAgentId
        headroomSavingsIngestUrl: 'https://ingest.test/savings',
      }),
    );

    // setupHeadroom still receives the raw agent id (it maps internally for init).
    expect(setupHeadroom).toHaveBeenCalledWith('claude_code');

    // But the env injected into the child is the MAPPED kind, matching what
    // `headroom init` registered + what codespaces report.
    expect(calls).toHaveLength(1);
    expect(calls[0].env.HEADROOM_ENABLED).toBe('1');
    expect(calls[0].env.HEADROOM_AGENT).toBe('claude');

    fs.rmSync(cwdTarget, { recursive: true, force: true });
  });

  it('does NOT inject HEADROOM_* env vars when headroomEnabled=true but setup fails', async () => {
    const cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-hr-'));
    const { sup, setupHeadroom, calls } = makeHeadroomSupervisor(false); // setup fails

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

    await sup.handleCommand(
      deployCmd({
        repoOrPath: cwdTarget,
        headroomEnabled: true,
        headroomAgent: 'claude',
        headroomSavingsIngestUrl: 'https://ingest.test/savings',
      }),
    );

    // setupHeadroom was called.
    expect(setupHeadroom).toHaveBeenCalledWith('claude');

    // Child was still spawned (never-break).
    expect(calls).toHaveLength(1);

    // No HEADROOM_* vars — broken install must not leave a dangling ANTHROPIC_BASE_URL.
    expect(calls[0].env.HEADROOM_ENABLED).toBeUndefined();
    expect(calls[0].env.HEADROOM_AGENT).toBeUndefined();
    expect(calls[0].env.HEADROOM_SAVINGS_INGEST_URL).toBeUndefined();

    // Standard token still present.
    expect(calls[0].env.CODEAM_AUTO_TOKEN).toBe('auto-xyz');

    fs.rmSync(cwdTarget, { recursive: true, force: true });
  });

  it('does NOT call setupHeadroom and injects no HEADROOM_* vars when headroomEnabled=false', async () => {
    const cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-hr-'));
    const { sup, setupHeadroom, calls } = makeHeadroomSupervisor(true);

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

    await sup.handleCommand(
      deployCmd({
        repoOrPath: cwdTarget,
        headroomEnabled: false,
      }),
    );

    // Feature is off — setup helper never invoked.
    expect(setupHeadroom).not.toHaveBeenCalled();

    // Child spawned normally (never-break).
    expect(calls).toHaveLength(1);
    expect(calls[0].env.HEADROOM_ENABLED).toBeUndefined();

    fs.rmSync(cwdTarget, { recursive: true, force: true });
  });

  it('does NOT call setupHeadroom when headroom fields are absent (old backend payload)', async () => {
    const cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-hr-'));
    const { sup, setupHeadroom, calls } = makeHeadroomSupervisor(true);

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

    // Plain old deploy — no headroom fields.
    await sup.handleCommand(deployCmd({ repoOrPath: cwdTarget }));

    expect(setupHeadroom).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0].env.HEADROOM_ENABLED).toBeUndefined();

    fs.rmSync(cwdTarget, { recursive: true, force: true });
  });
});

// NOTE: a previous "real subprocess" test called setupHeadroomForSelfHosted()
// with the default runner. Now that the install pulls the real CPU-PyTorch +
// engine wheels, that test actually downloaded PyTorch on every CI run (slow,
// network-flaky, 30s timeout). The never-throw / false-when-absent contract is
// covered deterministically by the injectable-runner suite below, so the
// real-subprocess test was removed rather than have CI download torch.

// ─────────────────────────────────────────────────────────────────────────────
// setupHeadroomForSelfHosted — injectable runner tests
//
// These tests use a mock HeadroomRunner so no real apt/pip/python3 runs.
// They verify:
//   • Never-throw contract holds regardless of runner results.
//   • When pip is ABSENT (which fails for pip+pip3), the package-manager
//     install is attempted BEFORE the pip install.
//   • A PEP 668 "externally-managed-environment" error on the first pip
//     attempt triggers a retry with --break-system-packages.
// ─────────────────────────────────────────────────────────────────────────────

describe('setupHeadroomForSelfHosted — injectable runner (no real subprocess)', () => {
  /**
   * Build a complete mock HeadroomRunner from:
   *   `presentCmds` — set of command names that `which()` should return true for
   *   `runResponses` — map of `"<cmd>"` → result for `run()` calls; default
   *                    is `{ code: 0, stderr: '' }` for anything unmatched.
   *
   * `run` dispatches by `cmd`; for `python3` the first unmatched-by-args call
   * gets the plain 'python3' response; callers that need different per-args
   * behaviour should build a custom runner directly.
   */
  function makeRunner(
    presentCmds: string[],
    runResponses: Record<string, { code: number | null; stderr: string; stdout?: string }> = {},
  ): HeadroomRunner & { calls: Array<{ cmd: string; args: string[] }> } {
    const present = new Set(presentCmds);
    const calls: Array<{ cmd: string; args: string[] }> = [];
    return {
      calls,
      which(cmd: string): boolean {
        return present.has(cmd);
      },
      run(
        cmd: string,
        args: string[],
      ): Promise<{ code: number | null; stderr: string; stdout?: string }> {
        calls.push({ cmd, args });
        // Version probe: ONLY bare `python3` reports a ≥3.10 version, so the
        // resolver settles on `python3` (the interpreter these setup tests model
        // their pip behavior on) rather than a suffixed candidate. A
        // `runResponses[cmd]` carrying a `stdout` overrides this (lets a test pin
        // a specific version), otherwise default 3.11.
        if (args.length === 2 && args[0] === '-c' && args[1]?.includes('sys.version_info')) {
          if (runResponses[cmd]?.stdout !== undefined) {
            return Promise.resolve(runResponses[cmd]);
          }
          if (cmd === 'python3') {
            return Promise.resolve({ code: 0, stderr: '', stdout: '3.11' });
          }
          return Promise.resolve({ code: 1, stderr: 'not found', stdout: '' });
        }
        // pip-presence probe (`-m pip --version`): pip is available on python3.
        // PEP 668 affects `pip install`, not `--version`, so this stays code 0.
        if (args[0] === '-m' && args[1] === 'pip' && args[2] === '--version') {
          return Promise.resolve({
            code: cmd === 'python3' ? 0 : 1,
            stderr: '',
            stdout: 'pip 24.0',
          });
        }
        return Promise.resolve(runResponses[cmd] ?? { code: 0, stderr: '' });
      },
    };
  }

  it('never throws — returns boolean even when runner always fails', async () => {
    // pip present (which returns true for pip), but python3 -m pip fails.
    const runner = makeRunner(['pip'], {
      python3: { code: 1, stderr: 'some random error, not pep668' },
    });

    const result = await setupHeadroomForSelfHosted('claude', runner);
    expect(typeof result).toBe('boolean');
    expect(result).toBe(false); // install failed → false (never throws)
  });

  it('when pip is absent, calls the package-manager (apt-get) before python3 -m pip', async () => {
    // Simulate: pip absent, pip3 absent, apt-get present, headroom absent.
    // apt-get update+install succeed; python3 -m pip succeeds.
    // headroom not in presentCmds → init step skips → returns false.
    // We assert ORDER: pm install before pip install.
    //
    // When not running as root (the common test environment), the code prefixes
    // the pm command with `sudo`. The runner must therefore also accept `sudo`.
    const isRoot = process.getuid?.() === 0;
    const runner = makeRunner(
      ['apt-get'], // pip and pip3 are absent; headroom absent
      {
        // Root: command is 'apt-get'; non-root: command is 'sudo'.
        'apt-get': { code: 0, stderr: '' },
        sudo: { code: 0, stderr: '' },
        python3: { code: 0, stderr: '' },
      },
    );

    await setupHeadroomForSelfHosted('claude', runner);

    // When running as root the cmd is 'apt-get'; as non-root it is 'sudo'
    // with 'apt-get' as the first arg (e.g. ['apt-get', 'update']).
    const isAptUpdateCall = (c: { cmd: string; args: string[] }): boolean =>
      isRoot
        ? c.cmd === 'apt-get' && c.args.includes('update')
        : c.cmd === 'sudo' && c.args.includes('apt-get') && c.args.includes('update');

    const isAptInstallCall = (c: { cmd: string; args: string[] }): boolean =>
      isRoot
        ? c.cmd === 'apt-get' && c.args.includes('install')
        : c.cmd === 'sudo' && c.args.includes('apt-get') && c.args.includes('install');

    const aptUpdateIdx = runner.calls.findIndex(isAptUpdateCall);
    // The pip install uses the resolved ≥3.10 interpreter (may be python3.13,
    // python3.12, …, or python3 itself on modern Linux). Match any python3* cmd.
    const pipIdx = runner.calls.findIndex((c) => /^python3/.test(c.cmd));

    expect(aptUpdateIdx).toBeGreaterThanOrEqual(0);
    expect(pipIdx).toBeGreaterThanOrEqual(0);
    expect(aptUpdateIdx).toBeLessThan(pipIdx);

    // The apt-get install call must include python3 and python3-pip.
    const installCall = runner.calls.find(isAptInstallCall);
    expect(installCall).toBeDefined();
    expect(installCall!.args).toContain('python3');
    expect(installCall!.args).toContain('python3-pip');
  });

  it('retries python3 -m pip with --break-system-packages on PEP 668 error', async () => {
    // pip IS on PATH → ensurePip short-circuits.
    // First python3 -m pip install fails with PEP 668; retry with
    // --break-system-packages succeeds.
    // headroom is absent → init skips → overall false.
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: HeadroomRunner = {
      which(cmd: string): boolean {
        return cmd === 'pip'; // pip found; headroom absent
      },
      run(
        cmd: string,
        args: string[],
      ): Promise<{ code: number | null; stderr: string; stdout?: string }> {
        calls.push({ cmd, args });
        // Version probe (resolveHeadroomPython): any python binary probed via
        // `-c "import sys; print(...)"` → report 3.11 so the resolver succeeds.
        if (args.length === 2 && args[0] === '-c' && args[1]?.includes('sys.version_info')) {
          return Promise.resolve({ code: 0, stderr: '', stdout: '3.11' });
        }
        // pip-presence probe (resolveHeadroomPython) — pip IS available.
        if (args[0] === '-m' && args[1] === 'pip' && args[2] === '--version') {
          return Promise.resolve({ code: 0, stderr: '', stdout: 'pip 24.0' });
        }
        if (args[0] === '-m') {
          if (args.includes('--break-system-packages')) {
            return Promise.resolve({ code: 0, stderr: '' }); // retry succeeds
          }
          // First attempt fails with PEP 668.
          return Promise.resolve({
            code: 1,
            stderr: 'error: externally-managed-environment\ninstall in a venv',
          });
        }
        return Promise.resolve({ code: 0, stderr: '' });
      },
    };

    const result = await setupHeadroomForSelfHosted('claude', runner);

    // All pip-related calls (install + model download) use the resolved interpreter.
    // Filter by calls that are pip installs or model predownloads (not version probes).
    const pipCalls = calls.filter(
      (c) => c.args[0] === '-m' || (c.args[0] === '-c' && c.args[1]?.includes('snapshot_download')),
    );

    // PEP 668 retry path exercised: at least one call carries the override.
    expect(pipCalls.some((c) => c.args.includes('--break-system-packages'))).toBe(true);

    // The Headroom ENGINE package is installed with the ONNX `[proxy,code]`
    // extras — this is the fix: no bare `headroom-ai`, and NO torch/`[ml]`.
    const headroomCall = pipCalls.find((c) => c.args.some((a) => a.startsWith('headroom-ai')));
    expect(headroomCall).toBeDefined();
    expect(headroomCall!.args).toContain('headroom-ai[proxy,code]');

    // Kompress runs on ONNX, not PyTorch — torch must NEVER be installed
    // (it's heavy + fragile + can hang the proxy). No call mentions torch.
    expect(
      pipCalls.some((c) =>
        c.args.some(
          (a) => a === 'torch' || a.includes('download.pytorch.org') || a === '[code,ml]',
        ),
      ),
    ).toBe(false);

    // The Kompress model is pre-downloaded (both HF repos) so the proxy's
    // eager-preload hits a warm cache and the first prompt isn't stalled.
    const predownloadCall = pipCalls.find(
      (c) => c.args[0] === '-c' && c.args[1]?.includes('snapshot_download'),
    );
    expect(predownloadCall).toBeDefined();
    expect(predownloadCall!.args[1]).toContain('chopratejas/kompress-v2-base');
    expect(predownloadCall!.args[1]).toContain('answerdotai/ModernBERT-base');

    // Every pip INSTALL call uses `<py> -m pip install --quiet ...`. (The
    // `-c "...snapshot_download..."` pre-download call is not a pip install.)
    const installCalls = pipCalls.filter((c) => c.args[0] === '-m' && c.args[2] === 'install');
    for (const c of installCalls) {
      expect(c.args.slice(0, 4)).toEqual(['-m', 'pip', 'install', '--quiet']);
    }

    // Install ok, but headroom not on PATH → init skips → false.
    expect(result).toBe(false);
  });

  it('returns false (never throws) when PEP 668 retry also fails', async () => {
    // Both pip install attempts fail (first: PEP 668; second: still PEP 668).
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: HeadroomRunner = {
      which(cmd: string): boolean {
        return cmd === 'pip';
      },
      run(
        cmd: string,
        args: string[],
      ): Promise<{ code: number | null; stderr: string; stdout?: string }> {
        calls.push({ cmd, args });
        // Version probe → succeed with 3.11 so the resolver passes.
        if (args.length === 2 && args[0] === '-c' && args[1]?.includes('sys.version_info')) {
          return Promise.resolve({ code: 0, stderr: '', stdout: '3.11' });
        }
        // pip-presence probe (resolveHeadroomPython) — pip IS available.
        if (args[0] === '-m' && args[1] === 'pip' && args[2] === '--version') {
          return Promise.resolve({ code: 0, stderr: '', stdout: 'pip 24.0' });
        }
        // All pip install attempts fail with PEP 668.
        return Promise.resolve({
          code: 1,
          stderr: 'error: externally-managed-environment',
        });
      },
    };

    const result = await setupHeadroomForSelfHosted('claude', runner);

    expect(result).toBe(false); // every install attempt failed → false (never throws)
    // The PEP 668 override retry was attempted before giving up.
    const pipCalls = calls.filter((c) => c.args[0] === '-m' && c.args[1] === 'pip');
    expect(pipCalls.some((c) => c.args.includes('--break-system-packages'))).toBe(true);
  });

  it('getFreeDiskBytes returns a positive number for a real dir, null for a bogus path', async () => {
    const real = await getFreeDiskBytes(os.tmpdir());
    expect(typeof real).toBe('number');
    expect(real as number).toBeGreaterThan(0);
    // statfs on a nonexistent path errors → null (caller treats as "unknown").
    expect(await getFreeDiskBytes('/no/such/path/xyzzy-12345')).toBeNull();
  });

  it('returns false (never throws) when no package manager is found and pip is absent', async () => {
    // pip absent, pip3 absent, no known package manager — which() always false.
    let runCalled = false;
    const runner: HeadroomRunner = {
      which(): boolean {
        return false; // nothing is on PATH
      },
      run(): Promise<{ code: number | null; stderr: string }> {
        runCalled = true;
        return Promise.resolve({ code: 0, stderr: '' });
      },
    };

    const result = await setupHeadroomForSelfHosted('claude', runner);

    expect(result).toBe(false); // no PM detected → bail before any run() call
    // runner.run must NOT have been called (ensurePip bailed with no PM found).
    expect(runCalled).toBe(false);
  });

  it('bare-box provision installs ca-certificates and curl when pip is absent (apt-get)', async () => {
    // Bare box: pip + pip3 absent, only apt-get present, headroom absent.
    // The install must include the TLS + fetch prerequisites so the PyPI
    // handshake during the later pip install can succeed.
    const isRoot = process.getuid?.() === 0;
    const runner = makeRunner(['apt-get'], {
      'apt-get': { code: 0, stderr: '' },
      sudo: { code: 0, stderr: '' },
      python3: { code: 0, stderr: '' },
    });

    await setupHeadroomForSelfHosted('claude', runner);

    const isInstallCall = (c: { cmd: string; args: string[] }): boolean =>
      isRoot
        ? c.cmd === 'apt-get' && c.args.includes('install')
        : c.cmd === 'sudo' && c.args.includes('apt-get') && c.args.includes('install');

    const installCall = runner.calls.find(isInstallCall);
    expect(installCall).toBeDefined();
    expect(installCall!.args).toContain('python3');
    expect(installCall!.args).toContain('python3-pip');
    expect(installCall!.args).toContain('ca-certificates');
    expect(installCall!.args).toContain('curl');
  });

  it('bare-box provision installs ca-certificates and curl on pacman and zypper', async () => {
    const isRoot = process.getuid?.() === 0;

    for (const pm of ['pacman', 'zypper'] as const) {
      const runner = makeRunner([pm], {
        [pm]: { code: 0, stderr: '' },
        sudo: { code: 0, stderr: '' },
        python3: { code: 0, stderr: '' },
      });

      await setupHeadroomForSelfHosted('claude', runner);

      // Find the package-manager install call (root: cmd is the pm; non-root: sudo <pm> …).
      const installCall = runner.calls.find((c) =>
        isRoot ? c.cmd === pm : c.cmd === 'sudo' && c.args[0] === pm,
      );
      expect(installCall, `expected a ${pm} install call`).toBeDefined();
      const argv = isRoot ? [installCall!.cmd, ...installCall!.args] : installCall!.args;
      expect(argv).toContain('ca-certificates');
      expect(argv).toContain('curl');
      // The Python interpreter package name differs per distro.
      expect(argv.some((a) => a === 'python3' || a === 'python')).toBe(true);
    }
  });

  it('fast-path: when pip is present, NO package-manager install runs', async () => {
    // pip on PATH → ensurePip short-circuits. The runner must never see
    // apt-get/apk/dnf/yum/pacman/zypper/sudo. This keeps healthy boxes from
    // eating an apt-update on every deploy. headroom absent → init skips →
    // overall false, but that's fine.
    const runner = makeRunner(['pip', 'apt-get'], {
      python3: { code: 0, stderr: '' },
    });

    await setupHeadroomForSelfHosted('claude', runner);

    const pmCmds = new Set(['apt-get', 'apk', 'dnf', 'yum', 'pacman', 'zypper', 'sudo']);
    const pmCalls = runner.calls.filter(
      (c) => pmCmds.has(c.cmd) || c.args.some((a) => pmCmds.has(a)),
    );
    expect(pmCalls).toHaveLength(0);
    // All non-probe run() calls must be python (pip install / model download).
    // The resolver adds version-probe calls (python3.13, python3.12, … python3) —
    // filter those out when asserting that only python commands ran.
    const nonProbeCalls = runner.calls.filter(
      (c) => !(c.args.length === 2 && c.args[0] === '-c' && c.args[1]?.includes('sys.version_info')),
    );
    expect(nonProbeCalls.every((c) => /^python3/.test(c.cmd))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveHeadroomPython — picks the newest Python ≥3.10, skips 3.9
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveHeadroomPython', () => {
  /**
   * Build a fake runner whose `run` dispatches based on the `cmd` argument.
   * `versionMap` maps a candidate binary (e.g. 'python3.13', 'python3') to the
   * version string the probe should report (e.g. '3.13'). Candidates missing
   * from the map fail the probe (simulate "not found / errors").
   */
  function makePyRunner(
    versionMap: Record<string, string>,
  ): HeadroomRunner & { runCalls: string[] } {
    const runCalls: string[] = [];
    return {
      runCalls,
      which(): boolean {
        return false; // which() is not used by resolveHeadroomPython
      },
      run(
        cmd: string,
        _args: string[],
      ): Promise<{ code: number | null; stderr: string; stdout?: string }> {
        runCalls.push(cmd);
        if (cmd in versionMap) {
          return Promise.resolve({ code: 0, stderr: '', stdout: versionMap[cmd] });
        }
        // Not in map → simulate "not found" (non-zero exit).
        return Promise.resolve({ code: 1, stderr: 'No such file', stdout: '' });
      },
    };
  }

  it('returns python3.13 (not python3) when bare python3=3.9 and python3.13=3.13', async () => {
    const runner = makePyRunner({ python3: '3.9', python3_13: '3.13' });
    // Version-suffixed candidates use the exact suffix name, e.g. 'python3.13'.
    // Override the map key to match what the resolver actually passes to `run`.
    const r2 = makePyRunner({ python3: '3.9' });
    // Re-use makePyRunner with the correct key format.
    const runner2 = {
      runCalls: [] as string[],
      which(): boolean {
        return false;
      },
      run(
        cmd: string,
        _args: string[],
      ): Promise<{ code: number | null; stderr: string; stdout?: string }> {
        runner2.runCalls.push(cmd);
        if (cmd === 'python3.13') return Promise.resolve({ code: 0, stderr: '', stdout: '3.13' });
        if (cmd === 'python3') return Promise.resolve({ code: 0, stderr: '', stdout: '3.9' });
        return Promise.resolve({ code: 1, stderr: '', stdout: '' });
      },
    };
    const result = await resolveHeadroomPython(runner2);
    expect(result).toBe('python3.13'); // suffix wins over bare python3
    // Bare python3 must NOT have been returned despite being reachable.
    expect(result).not.toBe('python3');
  });

  it('returns null when only bare python3=3.9 and no suffixed interpreter exists', async () => {
    const runner: HeadroomRunner = {
      which(): boolean {
        return false;
      },
      run(
        cmd: string,
        _args: string[],
      ): Promise<{ code: number | null; stderr: string; stdout?: string }> {
        if (cmd === 'python3') return Promise.resolve({ code: 0, stderr: '', stdout: '3.9' });
        return Promise.resolve({ code: 1, stderr: '', stdout: '' });
      },
    };
    const result = await resolveHeadroomPython(runner);
    expect(result).toBeNull();
  });

  it('returns python3 when bare python3=3.11 and no suffixed interpreter exists', async () => {
    const runner: HeadroomRunner = {
      which(): boolean {
        return false;
      },
      run(
        cmd: string,
        _args: string[],
      ): Promise<{ code: number | null; stderr: string; stdout?: string }> {
        if (cmd === 'python3') return Promise.resolve({ code: 0, stderr: '', stdout: '3.11' });
        return Promise.resolve({ code: 1, stderr: '', stdout: '' });
      },
    };
    const result = await resolveHeadroomPython(runner);
    expect(result).toBe('python3');
  });

  it('prefers python3.13 over python3.11 when both qualify (newest-first ordering)', async () => {
    const runner: HeadroomRunner = {
      which(): boolean {
        return false;
      },
      run(
        cmd: string,
        _args: string[],
      ): Promise<{ code: number | null; stderr: string; stdout?: string }> {
        if (cmd === 'python3.13') return Promise.resolve({ code: 0, stderr: '', stdout: '3.13' });
        if (cmd === 'python3.11') return Promise.resolve({ code: 0, stderr: '', stdout: '3.11' });
        if (cmd === 'python3') return Promise.resolve({ code: 0, stderr: '', stdout: '3.11' });
        return Promise.resolve({ code: 1, stderr: '', stdout: '' });
      },
    };
    const result = await resolveHeadroomPython(runner);
    expect(result).toBe('python3.13');
  });

  it('skips a newest python that lacks pip and picks the older one that has pip', async () => {
    // Regression: a box can have a pip-less newest python (e.g. a distro's
    // `python3.13-minimal` pulled as a transitive dep) alongside a complete
    // `python3.12` with pip. The resolver must pick the pip-capable one.
    const runner: HeadroomRunner = {
      which(): boolean {
        return false;
      },
      run(
        cmd: string,
        args: string[],
      ): Promise<{ code: number | null; stderr: string; stdout?: string }> {
        const isPipCheck = args[0] === '-m' && args[1] === 'pip' && args[2] === '--version';
        if (cmd === 'python3.13') {
          return Promise.resolve(
            isPipCheck
              ? { code: 1, stderr: 'No module named pip', stdout: '' } // newest, but pip-less
              : { code: 0, stderr: '', stdout: '3.13' },
          );
        }
        if (cmd === 'python3.12') {
          return Promise.resolve(
            isPipCheck
              ? { code: 0, stderr: '', stdout: 'pip 24.0' }
              : { code: 0, stderr: '', stdout: '3.12' },
          );
        }
        return Promise.resolve({ code: 1, stderr: '', stdout: '' });
      },
    };
    const result = await resolveHeadroomPython(runner);
    expect(result).toBe('python3.12'); // skipped the pip-less 3.13
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ensureModernPython — auto-installs a ≥3.10 Python when none is present
// ─────────────────────────────────────────────────────────────────────────────

describe('ensureModernPython — auto-install when no Python ≥3.10', () => {
  const origPlatform = process.platform;

  function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  });

  /**
   * Runner with a mutable per-binary version map so an install can "appear" to
   * make a new interpreter resolvable: the install command flips a binary's
   * reported version. `whichSet` controls which() (e.g. 'brew', 'apt-get').
   * `onInstall` runs when a recognised install command is seen, letting a test
   * mutate `versions` to simulate the interpreter landing on PATH.
   */
  function makeRunner(
    whichSet: string[],
    versions: Record<string, string>,
    onInstall?: (cmd: string, args: string[]) => void,
  ): HeadroomRunner & { calls: Array<{ cmd: string; args: string[] }> } {
    const present = new Set(whichSet);
    const calls: Array<{ cmd: string; args: string[] }> = [];
    return {
      calls,
      which: (cmd: string): boolean => present.has(cmd),
      run(
        cmd: string,
        args: string[],
      ): Promise<{ code: number | null; stderr: string; stdout?: string }> {
        calls.push({ cmd, args });
        // Version probe: `<py> -c "import sys; ..."`.
        if (args.length === 2 && args[0] === '-c' && args[1]?.includes('sys.version_info')) {
          if (cmd in versions) {
            return Promise.resolve({ code: 0, stderr: '', stdout: versions[cmd] });
          }
          return Promise.resolve({ code: 1, stderr: 'not found', stdout: '' });
        }
        // Install command (brew / apt-get / etc.) → let the test mutate state.
        onInstall?.(cmd, args);
        return Promise.resolve({ code: 0, stderr: '', stdout: '' });
      },
    };
  }

  it('darwin + brew: installs python@3.12 then re-resolves to the new interpreter', async () => {
    setPlatform('darwin');
    // Initially only Xcode python3=3.9. brew install makes python3.12 appear.
    const versions: Record<string, string> = { python3: '3.9' };
    const runner = makeRunner(['brew'], versions, (cmd, args) => {
      if (cmd === 'brew' && args[0] === 'install') {
        versions['python3.12'] = '3.12';
      }
    });

    const result = await ensureModernPython(runner);
    expect(result).toBe('python3.12');

    const brewInstall = runner.calls.find(
      (c) => c.cmd === 'brew' && c.args[0] === 'install' && c.args[1] === 'python@3.12',
    );
    expect(brewInstall).toBeDefined();
  });

  it('linux + apt: installs a versioned python package then re-resolves', async () => {
    setPlatform('linux');
    const versions: Record<string, string> = { python3: '3.9' };
    const runner = makeRunner(['apt-get'], versions, (cmd, args) => {
      // First apt-get install (python3.12) "lands" a ≥3.10 interpreter.
      if ((cmd === 'apt-get' || cmd === 'sudo') && args.includes('python3.12')) {
        versions['python3.12'] = '3.12';
      }
    });

    const result = await ensureModernPython(runner);
    expect(result).toBe('python3.12');

    const aptInstall = runner.calls.find(
      (c) =>
        (c.cmd === 'apt-get' || c.cmd === 'sudo') &&
        c.args.includes('install') &&
        c.args.includes('python3.12'),
    );
    expect(aptInstall).toBeDefined();
  });

  it('darwin without brew: no install attempted, returns null', async () => {
    setPlatform('darwin');
    const runner = makeRunner([], { python3: '3.9' });

    const result = await ensureModernPython(runner);
    expect(result).toBeNull();

    // No brew install command should have been issued.
    const brewInstall = runner.calls.find((c) => c.cmd === 'brew');
    expect(brewInstall).toBeUndefined();
  });

  it('happy path: a ≥3.10 interpreter already present → no install command', async () => {
    setPlatform('darwin');
    const runner = makeRunner(['brew', 'apt-get'], { 'python3.13': '3.13', python3: '3.9' });

    const result = await ensureModernPython(runner);
    expect(result).toBe('python3.13');

    // Neither brew nor any package-manager install should run.
    const installs = runner.calls.filter(
      (c) =>
        c.cmd === 'brew' ||
        c.cmd === 'apt-get' ||
        (c.cmd === 'sudo' && c.args[0] === 'apt-get'),
    );
    expect(installs).toHaveLength(0);
  });

  it('install fails to yield ≥3.10 → returns null (caller skips Headroom)', async () => {
    setPlatform('darwin');
    // brew is present and is invoked, but the interpreter never appears.
    const runner = makeRunner(['brew'], { python3: '3.9' });

    const result = await ensureModernPython(runner);
    expect(result).toBeNull();

    // The install WAS attempted (best-effort), it just didn't help.
    const brewInstall = runner.calls.find((c) => c.cmd === 'brew' && c.args[0] === 'install');
    expect(brewInstall).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// setupHeadroomForSelfHosted — uses resolved python, skips on no ≥3.10 python
// ─────────────────────────────────────────────────────────────────────────────

describe('setupHeadroomForSelfHosted — python resolver integration', () => {
  /**
   * Build a runner where:
   *   - `whichSet`: commands that which() returns true for
   *   - `pythonVersions`: cmd → version string for probe calls (if absent → code 1)
   *   - all other run() calls (pip install, model download, headroom init) succeed
   */
  function makeFullRunner(
    whichSet: string[],
    pythonVersions: Record<string, string>,
  ): HeadroomRunner & { calls: Array<{ cmd: string; args: string[] }> } {
    const present = new Set(whichSet);
    const calls: Array<{ cmd: string; args: string[] }> = [];
    return {
      calls,
      which(cmd: string): boolean {
        return present.has(cmd);
      },
      run(
        cmd: string,
        args: string[],
      ): Promise<{ code: number | null; stderr: string; stdout?: string }> {
        calls.push({ cmd, args });
        // Version probe: single -c arg containing sys.version_info
        if (args.length === 2 && args[0] === '-c' && args[1]?.includes('sys.version_info')) {
          if (cmd in pythonVersions) {
            return Promise.resolve({ code: 0, stderr: '', stdout: pythonVersions[cmd] });
          }
          return Promise.resolve({ code: 1, stderr: '', stdout: '' });
        }
        return Promise.resolve({ code: 0, stderr: '', stdout: '' });
      },
    };
  }

  it('uses python3.13 (not python3) for pip install when python3.13=3.13 and python3=3.9', async () => {
    const runner = makeFullRunner(
      ['pip', 'headroom'],
      { python3: '3.9', 'python3.13': '3.13' },
    );

    const result = await setupHeadroomForSelfHosted('claude', runner);
    // Setup should succeed (headroom on PATH, all commands return code 0).
    expect(result).toBe(true);

    // All pip install calls and model predownload must use python3.13, not python3.
    const pipAndModelCalls = runner.calls.filter(
      (c) =>
        (c.args[0] === '-m' && c.args[1] === 'pip') ||
        (c.args[0] === '-c' && c.args[1]?.includes('snapshot_download')),
    );
    expect(pipAndModelCalls.length).toBeGreaterThan(0);
    for (const c of pipAndModelCalls) {
      expect(c.cmd).toBe('python3.13');
      expect(c.cmd).not.toBe('python3');
    }
  });

  it('returns false and skips install when no Python ≥3.10 is available', async () => {
    // pip is present (ensurePip passes), but every python binary returns 3.9.
    const runner = makeFullRunner(['pip', 'headroom'], { python3: '3.9' });

    const result = await setupHeadroomForSelfHosted('claude', runner);
    expect(result).toBe(false);

    // No pip install or model download should have been attempted.
    const installCalls = runner.calls.filter(
      (c) => c.args[0] === '-m' && c.args[1] === 'pip' && c.args[2] === 'install',
    );
    expect(installCalls).toHaveLength(0);
  });
});

describe('detectPackageManager — coverage across distros', () => {
  /** Minimal runner that reports a fixed set of commands as present on PATH. */
  function whichOnly(present: string[]): Pick<HeadroomRunner, 'which'> {
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
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn() }),
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
      makeRelay: () => ({ start: vi.fn(), stop: vi.fn() }),
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

    // Next idle tick: no re-install (still 1 call), and the deferred restart fires.
    await sup.selfUpdateTick();
    expect(selfUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdated).toHaveBeenCalledTimes(1);
    expect(onUpdated).toHaveBeenCalledWith('9.9.9');

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
// Headroom config persistence — survives resume / restart
//
// The supervisor persists the headroom config on a successful deploy and
// re-reads it on EVERY child spawn (fresh deploy AND resume/restart) so the
// savings reporter starts even when no fresh deploy arrives. These tests rely
// on the tmpHome isolation set up in the top-level beforeEach so writes land in
// a throwaway ~/.codeam.
// ─────────────────────────────────────────────────────────────────────────────

describe('readHeadroomChildEnv — persisted config → child env', () => {
  it('returns the 3 HEADROOM_* env vars when the config is enabled + complete', () => {
    persistHeadroomConfig({
      enabled: true,
      agent: 'claude',
      ingestUrl: 'https://ingest.test/savings',
    });

    expect(readHeadroomChildEnv()).toEqual({
      HEADROOM_ENABLED: '1',
      HEADROOM_AGENT: 'claude',
      HEADROOM_SAVINGS_INGEST_URL: 'https://ingest.test/savings',
    });
  });

  it('returns {} when the config is disabled', () => {
    persistHeadroomConfig({ enabled: false });
    expect(readHeadroomChildEnv()).toEqual({});
  });

  it('returns {} when the config file is missing', () => {
    // No file written → nothing to read.
    expect(fs.existsSync(headroomConfigPath())).toBe(false);
    expect(readHeadroomChildEnv()).toEqual({});
  });

  it('returns {} when enabled but agent/ingestUrl are absent (incomplete)', () => {
    persistHeadroomConfig({ enabled: true }); // no agent / ingestUrl
    expect(readHeadroomChildEnv()).toEqual({});
  });

  it('returns {} on a corrupt / non-JSON config file (never throws)', () => {
    fs.mkdirSync(path.dirname(headroomConfigPath()), { recursive: true });
    fs.writeFileSync(headroomConfigPath(), '{ this is not json');
    expect(readHeadroomChildEnv()).toEqual({});
  });

  it('persists atomically + 0600 and round-trips through read', () => {
    persistHeadroomConfig({
      enabled: true,
      agent: 'codex',
      ingestUrl: 'https://ingest.test/x',
    });
    const file = headroomConfigPath();
    expect(fs.existsSync(file)).toBe(true);
    expect(isOwnerOnly(file)).toBe(true);
    // No leftover temp file from the atomic write.
    const leftovers = fs
      .readdirSync(path.dirname(file))
      .filter((n) => n.startsWith('headroom-config.json.tmp'));
    expect(leftovers).toEqual([]);
    expect(readHeadroomChildEnv().HEADROOM_AGENT).toBe('codex');
  });

  it('returns HEADROOM_BUDGET + HEADROOM_BUDGET_PERIOD when persisted config has budget', () => {
    persistHeadroomConfig({
      enabled: true,
      agent: 'claude',
      ingestUrl: 'https://ingest.test/savings',
      budgetEnabled: true,
      budgetUsd: 10,
      budgetPeriod: 'daily',
    });

    expect(readHeadroomChildEnv()).toEqual({
      HEADROOM_ENABLED: '1',
      HEADROOM_AGENT: 'claude',
      HEADROOM_SAVINGS_INGEST_URL: 'https://ingest.test/savings',
      HEADROOM_BUDGET: '10',
      HEADROOM_BUDGET_PERIOD: 'daily',
    });
  });

  it('returns HEADROOM_BUDGET with default period "daily" when budgetPeriod is absent', () => {
    persistHeadroomConfig({
      enabled: true,
      agent: 'codex',
      ingestUrl: 'https://ingest.test/savings',
      budgetEnabled: true,
      budgetUsd: 5,
    });

    const env = readHeadroomChildEnv();
    expect(env['HEADROOM_BUDGET']).toBe('5');
    expect(env['HEADROOM_BUDGET_PERIOD']).toBe('daily');
  });

  it('omits HEADROOM_BUDGET when budgetEnabled is false in persisted config', () => {
    persistHeadroomConfig({
      enabled: true,
      agent: 'claude',
      ingestUrl: 'https://ingest.test/savings',
      budgetEnabled: false,
    });

    const env = readHeadroomChildEnv();
    expect(env['HEADROOM_BUDGET']).toBeUndefined();
    expect(env['HEADROOM_BUDGET_PERIOD']).toBeUndefined();
  });

  it('omits HEADROOM_BUDGET when budgetEnabled is true but budgetUsd is absent', () => {
    persistHeadroomConfig({
      enabled: true,
      agent: 'claude',
      ingestUrl: 'https://ingest.test/savings',
      budgetEnabled: true,
      // budgetUsd deliberately omitted
    });

    const env = readHeadroomChildEnv();
    expect(env['HEADROOM_BUDGET']).toBeUndefined();
    expect(env['HEADROOM_BUDGET_PERIOD']).toBeUndefined();
  });

  it('omits HEADROOM_BUDGET when config has no budget fields (backward compat with old configs)', () => {
    // Old config without budget fields — must NOT inject budget vars.
    persistHeadroomConfig({
      enabled: true,
      agent: 'claude',
      ingestUrl: 'https://ingest.test/savings',
    });

    const env = readHeadroomChildEnv();
    expect(env['HEADROOM_BUDGET']).toBeUndefined();
    expect(env['HEADROOM_BUDGET_PERIOD']).toBeUndefined();
  });
});

describe('HostAgentSupervisor — deploy persists headroom config', () => {
  function makeHeadroomSupervisor(setupHeadroomResult: boolean) {
    const setupHeadroom = vi
      .fn<(a: string) => Promise<boolean>>()
      .mockResolvedValue(setupHeadroomResult);
    const resolveAgentAuth = vi
      .fn<(i: SealedHostIdentity, s: string) => Promise<AgentAuth>>()
      .mockResolvedValue({ kind: 'oauth_token', value: '{"claudeAiOauth":{}}' });
    const calls: Array<{ env: Record<string, string> }> = [];
    const spawnChild: ChildSpawner = (env) => {
      calls.push({ env });
      return fakeChildWithStreams();
    };
    const sup = new HostAgentSupervisor(IDENTITY, { spawnChild, resolveAgentAuth, setupHeadroom });
    return { sup, calls };
  }

  function readConfig(): Record<string, unknown> | null {
    try {
      return JSON.parse(fs.readFileSync(headroomConfigPath(), 'utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  beforeEach(() => {
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
  });

  it('persists enabled config with the MAPPED agent + ingestUrl when setup succeeds', async () => {
    const cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-hrp-'));
    const { sup, calls } = makeHeadroomSupervisor(true);

    await sup.handleCommand(
      deployCmd({
        repoOrPath: cwdTarget,
        headroomEnabled: true,
        headroomAgent: 'claude_code', // raw LinkedAgentId → mapped to `claude`
        headroomSavingsIngestUrl: 'https://ingest.test/savings',
      }),
    );

    // Persisted with the mapped kind, not the raw LinkedAgentId.
    expect(readConfig()).toEqual({
      enabled: true,
      agent: 'claude',
      ingestUrl: 'https://ingest.test/savings',
    });

    // And the spawned child got the env (read from the persisted file).
    expect(calls[0].env.HEADROOM_ENABLED).toBe('1');
    expect(calls[0].env.HEADROOM_AGENT).toBe('claude');
    expect(calls[0].env.HEADROOM_SAVINGS_INGEST_URL).toBe('https://ingest.test/savings');

    fs.rmSync(cwdTarget, { recursive: true, force: true });
  });

  it('persists disabled config when headroom setup fails (no dead-proxy on resume)', async () => {
    const cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-hrp-'));
    const { sup, calls } = makeHeadroomSupervisor(false); // setup fails

    await sup.handleCommand(
      deployCmd({
        repoOrPath: cwdTarget,
        headroomEnabled: true,
        headroomAgent: 'claude',
        headroomSavingsIngestUrl: 'https://ingest.test/savings',
      }),
    );

    expect(readConfig()).toEqual({ enabled: false });
    // Child still spawned, but with NO headroom env.
    expect(calls[0].env.HEADROOM_ENABLED).toBeUndefined();

    fs.rmSync(cwdTarget, { recursive: true, force: true });
  });

  it('persists disabled config when headroomEnabled is false (clears stale enabled)', async () => {
    // Pre-seed an ENABLED config (as if a prior deploy turned it on).
    persistHeadroomConfig({ enabled: true, agent: 'claude', ingestUrl: 'https://old/x' });

    const cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-hrp-'));
    const { sup, calls } = makeHeadroomSupervisor(true);

    await sup.handleCommand(deployCmd({ repoOrPath: cwdTarget, headroomEnabled: false }));

    // The explicit-off deploy cleared the stale enabled config.
    expect(readConfig()).toEqual({ enabled: false });
    expect(calls[0].env.HEADROOM_ENABLED).toBeUndefined();

    fs.rmSync(cwdTarget, { recursive: true, force: true });
  });
});

describe('HostAgentSupervisor — resume/restart spawn re-injects persisted headroom env', () => {
  it('a spawn AFTER a prior deploy enabled headroom (no fresh headroom payload) gets HEADROOM_* env', async () => {
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

    // Simulate the state a prior successful headroom deploy left behind: the
    // persisted config on disk. This is exactly what survives a supervisor
    // restart (systemd / self-update) — the in-memory deploy payload is gone.
    persistHeadroomConfig({
      enabled: true,
      agent: 'claude',
      ingestUrl: 'https://ingest.test/savings',
    });

    const calls: Array<{ env: Record<string, string> }> = [];
    const spawnChild: ChildSpawner = (env) => {
      calls.push({ env });
      return fakeChildWithStreams();
    };
    const resolveAgentAuth = vi
      .fn<(i: SealedHostIdentity, s: string) => Promise<AgentAuth>>()
      .mockResolvedValue({ kind: 'oauth_token', value: '{"claudeAiOauth":{}}' });
    // setupHeadroom must NOT be invoked on this spawn — the payload carries NO
    // headroom fields (a resume/restart deploy), yet the env still flows from
    // the persisted config.
    const setupHeadroom = vi.fn<(a: string) => Promise<boolean>>().mockResolvedValue(true);
    const sup = new HostAgentSupervisor(IDENTITY, { spawnChild, resolveAgentAuth, setupHeadroom });

    const cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-hrr-'));
    // A plain deploy with NO headroom fields (mirrors a resume that re-spawns
    // the session child without the original headroom payload).
    await sup.handleCommand(deployCmd({ repoOrPath: cwdTarget }));

    // setupHeadroom was NOT called (no fresh headroom payload)…
    expect(setupHeadroom).not.toHaveBeenCalled();
    // …but the child STILL received the HEADROOM_* env from the persisted config.
    expect(calls).toHaveLength(1);
    expect(calls[0].env.HEADROOM_ENABLED).toBe('1');
    expect(calls[0].env.HEADROOM_AGENT).toBe('claude');
    expect(calls[0].env.HEADROOM_SAVINGS_INGEST_URL).toBe('https://ingest.test/savings');
    // Standard token still present (never-break).
    expect(calls[0].env.CODEAM_AUTO_TOKEN).toBe('auto-xyz');

    fs.rmSync(cwdTarget, { recursive: true, force: true });
  });
});

describe('maybeResumeLocalHeadroomReporter — on-demand local resume (additive)', () => {
  const ctx = { sessionId: 'sess-1', pluginId: 'plug-1', pluginAuthToken: 'tok-1' };
  let savedEnabled: string | undefined;

  beforeEach(() => {
    savedEnabled = process.env.HEADROOM_ENABLED;
  });
  afterEach(() => {
    if (savedEnabled === undefined) delete process.env.HEADROOM_ENABLED;
    else process.env.HEADROOM_ENABLED = savedEnabled;
  });

  it('returns null when HEADROOM_ENABLED=1 (codespace path owns it — never overlaps)', () => {
    process.env.HEADROOM_ENABLED = '1';
    persistHeadroomConfig({ enabled: true, agent: 'claude' });
    expect(maybeResumeLocalHeadroomReporter(ctx)).toBeNull();
  });

  it('returns null when no config file exists', () => {
    delete process.env.HEADROOM_ENABLED;
    expect(maybeResumeLocalHeadroomReporter(ctx)).toBeNull();
  });

  it('returns null when the persisted config says enabled:false', () => {
    delete process.env.HEADROOM_ENABLED;
    persistHeadroomConfig({ enabled: false, agent: 'claude' });
    expect(maybeResumeLocalHeadroomReporter(ctx)).toBeNull();
  });

  it('starts a reporter when config says enabled:true and it is not a codespace', () => {
    delete process.env.HEADROOM_ENABLED;
    persistHeadroomConfig({ enabled: true, agent: 'claude' });
    const reporter = maybeResumeLocalHeadroomReporter(ctx);
    expect(reporter).not.toBeNull();
    reporter?.stop();
  });
});
