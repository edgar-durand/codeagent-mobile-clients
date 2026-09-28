// Scratch (repo-less "Start from scratch") self-hosted deploys — Task 2 of the
// 2026-09-28 scratch-Box design. Keeps `host-agent.test.ts` untouched; this
// file borrows only the pieces of its harness needed to exercise
// `source: 'scratch'`.
process.env.CODEAM_HOST_SESSION_STATE_FILE = `${process.env.TMPDIR ?? '/tmp'}/codeam-host-sessions-scratch-test-${process.pid}.json`;

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { AgentAuth } from '@codeam/shared';

import {
  HostAgentSupervisor,
  type ChildSpawner,
} from '../src/commands/host-agent';
import type { RemoteCommand } from '../src/services/command-relay.service';
import type { SealedHostIdentity } from '../src/commands/host/host-client';

// House-proxy config: keep the pure env builder real (unused here — these
// deploys use sealedAgentAuth), but stub the persistence side effects so we
// don't depend on their on-disk shape, mirroring host-agent.test.ts.
vi.mock('../src/commands/host/house-proxy-config', async (importActual) => {
  const actual = await importActual<typeof import('../src/commands/host/house-proxy-config')>();
  return {
    ...actual,
    readHouseProxyChildEnv: vi.fn(() => ({})),
    persistHouseProxyConfig: vi.fn(),
    clearHouseProxyConfig: vi.fn(),
  };
});

// getActiveSession reads the real ~/.codeam config — default to "no session"
// so nothing auto-resumes underneath these tests.
vi.mock('../src/config', async (importActual) => {
  const actual = await importActual<typeof import('../src/config')>();
  return { ...actual, getActiveSession: vi.fn(() => null) };
});

// Spy on `prepareWorkspace` (the clone path) so we can assert it is NOT
// invoked for a scratch deploy, and IS invoked (unchanged) for a repo deploy.
vi.mock('../src/commands/host/workspace', async (importActual) => {
  const actual = await importActual<typeof import('../src/commands/host/workspace')>();
  return { ...actual, prepareWorkspace: vi.fn(actual.prepareWorkspace) };
});

import { prepareWorkspace } from '../src/commands/host/workspace';

let tmpHome: string;
let origHome: string | undefined;
let origUserProfile: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-host-scratch-'));
  origHome = process.env.HOME;
  origUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  try {
    fs.rmSync(process.env.CODEAM_HOST_SESSION_STATE_FILE as string, { force: true });
  } catch {
    /* ignore */
  }
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

function makeSupervisor(spawnChild: ChildSpawner) {
  const resolveAgentAuth = vi
    .fn<(i: SealedHostIdentity, s: string) => Promise<AgentAuth>>()
    .mockResolvedValue({ kind: 'oauth_token', value: '{"claudeAiOauth":{}}' });
  return {
    sup: new HostAgentSupervisor(IDENTITY, { spawnChild, resolveAgentAuth }),
    resolveAgentAuth,
  };
}

describe('self_hosted_deploy — scratch (repo-less) workspace', () => {
  it('spawns the child in ~/.codeam/self-hosted/<deployId> without cloning, for source: "scratch"', async () => {
    const calls: Array<{ env: Record<string, string>; cwd: string }> = [];
    const spawnChild: ChildSpawner = (env, cwd) => {
      calls.push({ env, cwd });
      return fakeChild();
    };
    const { sup } = makeSupervisor(spawnChild);

    await sup.handleCommand(
      deployCmd({ source: 'scratch', repoOrPath: 'scratch', deployId: 'deploy-scratch-1' }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe(path.join(tmpHome, '.codeam', 'self-hosted', 'deploy-scratch-1'));
    expect(fs.existsSync(path.join(calls[0].cwd, '.git', 'codeam-scratch'))).toBe(true);
    expect(prepareWorkspace).not.toHaveBeenCalled();
  });

  it('still clones for a repo deploy without `source` (unchanged)', async () => {
    const cwdTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-ws-'));
    const calls: Array<{ env: Record<string, string>; cwd: string }> = [];
    const spawnChild: ChildSpawner = (env, cwd) => {
      calls.push({ env, cwd });
      return fakeChild();
    };
    const { sup } = makeSupervisor(spawnChild);

    await sup.handleCommand(deployCmd({ repoOrPath: cwdTarget }));

    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe(cwdTarget);
    expect(prepareWorkspace).toHaveBeenCalledWith(
      cwdTarget,
      'deploy-1',
      undefined,
      'github',
      undefined,
    );

    fs.rmSync(cwdTarget, { recursive: true, force: true });
  });
});
