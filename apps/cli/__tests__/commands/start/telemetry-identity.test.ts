/**
 * codeagent-tach: `start` identified the CLI user by EMAIL, so every CLI user
 * became a second PostHog person beside the app's user-id person (the first
 * paying subscriber was counted twice, and PostHog will not merge two
 * identified persons). The distinct id must be the backend user id — persisted
 * on the session, or backfilled from /reconnect — and never the email.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fakeSessionBase = {
  id: 'sess-1',
  pluginId: 'plugin-1',
  userName: 'Test User',
  userEmail: 'test@example.com',
  plan: 'PRO',
  pairedAt: Date.now(),
  pluginAuthToken: 'tok-abc123',
  pollSecret: 'poll-secret',
};

import { guardProdApi } from '../../fixtures/prod-api-guard';

guardProdApi();

vi.mock('../../../src/config', () => ({
  addSession: vi.fn(),
  getActiveSession: vi.fn(),
  getActiveSessionForAgent: vi.fn(),
  ensurePluginId: vi.fn(() => 'plugin-1'),
  loadCliConfig: vi.fn(() => ({ sessions: [] })),
}));

vi.mock('../../../src/commands/pair-auto', () => ({
  acquireDaemonLock: vi.fn(() => true),
}));

vi.mock('../../../src/ui/banner', () => ({
  showIntro: vi.fn(),
  showInfo: vi.fn(),
  showError: vi.fn(),
}));

vi.mock('../../../src/services/pairing.service', () => ({
  fetchCurrentPluginAuthToken: vi.fn(async () => null),
  postPreviewEvent: vi.fn(),
}));

vi.mock('../../../src/services/telemetry.service', () => ({
  capture: vi.fn(),
  identifyUser: vi.fn(),
  shutdownTelemetry: vi.fn(),
}));

vi.mock('../../../src/agents/claude/onboarding', () => ({
  ensureClaudeOnboarded: vi.fn(),
}));

vi.mock('../../../src/beads/wiring', () => ({
  provisionBeadsForStart: vi.fn(async () => null),
}));

// Best-effort backend calls on the start path: unmocked, they reached the
// production API on every run (see fixtures/prod-api-guard.ts).
vi.mock('../../../src/integrations/refresh-manifest', () => ({
  refreshIntegrationsManifest: vi.fn(async () => ({ status: 'skipped', reason: 'test' })),
}));
vi.mock('../../../src/agents/claude/credential-sync', () => ({
  startClaudeCredentialSync: vi.fn(() => ({ stop: vi.fn(async () => undefined) })),
}));
vi.mock('../../../src/integrations/provision', () => ({
  buildMcpServersForStart: vi.fn(() => []),
}));

vi.mock('../../../src/baton/gate', () => ({
  isLocalSession: vi.fn(() => false),
  runtimeSupportsBaton: vi.fn(() => false),
}));

vi.mock('../../../src/baton/wire-baton', () => ({
  runBatonSession: vi.fn(),
}));


vi.mock('../../../src/agents/registry', () => ({
  createRuntimeStrategy: vi.fn(() => ({ meta: {} })),
  createInteractiveAgentStrategy: vi.fn(),
}));

vi.mock('../../../src/agents/acp/runner', () => ({
  runAcpSession: vi.fn(async () => undefined),
  surfaceStartupFailure: vi.fn(async () => undefined),
}));

vi.mock('../../../src/services/history.service', () => ({
  HistoryService: vi.fn(function () {
    return {};
  }),
}));

vi.mock('../../../src/services/output.service', () => ({
  OutputService: vi.fn(function () {
    return { dispose: vi.fn() };
  }),
}));

vi.mock('../../../src/services/agent.service', () => ({
  AgentLaunchError: class AgentLaunchError extends Error {},
  AgentService: vi.fn(function () {
    return {
      kill: vi.fn(),
      spawn: vi.fn(async () => {
        throw new Error('SENTINEL_SPAWN');
      }),
    };
  }),
}));

vi.mock('../../../src/services/command-relay.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/command-relay.service')>();
  return {
    ...actual,
    CommandRelayService: vi.fn(function () {
      return { setOnSessionGone: vi.fn(), start: vi.fn() };
    }),
    stopRelayWithGoodbye: vi.fn(async () => undefined),
  };
});

vi.mock('../../../src/services/terminal-ops.service', () => ({
  registerTerminalHandlers: vi.fn(),
  closeAllTerminals: vi.fn(),
}));

vi.mock('../../../src/commands/start/shutdown-tunnels', () => ({
  reapPreviewsAndExportTunnel: vi.fn(async () => undefined),
}));

import { start } from '../../../src/commands/start';
import { addSession, getActiveSession, getActiveSessionForAgent } from '../../../src/config';
import { fetchCurrentPluginAuthToken } from '../../../src/services/pairing.service';
import { capture, identifyUser } from '../../../src/services/telemetry.service';

function boot(session: Record<string, unknown>) {
  delete process.env.CODESPACES;
  const s = { ...fakeSessionBase, agent: 'aider' as const, ...session };
  vi.mocked(getActiveSession).mockReturnValue(s as never);
  vi.mocked(getActiveSessionForAgent).mockReturnValue(s as never);
  return start();
}

describe('start() telemetry identity', () => {
  beforeEach(() => {
    vi.mocked(identifyUser).mockClear();
    vi.mocked(capture).mockClear();
    vi.mocked(addSession).mockClear();
    vi.mocked(fetchCurrentPluginAuthToken).mockResolvedValue(null);
  });

  it('identifies by the persisted backend user id, never the email', async () => {
    await expect(boot({ userId: 'usr_1' })).rejects.toThrow('SENTINEL_SPAWN');
    expect(identifyUser).toHaveBeenCalledTimes(1);
    expect(vi.mocked(identifyUser).mock.calls[0][0]).toMatchObject({
      userId: 'usr_1',
      email: 'test@example.com',
    });
    expect(capture).toHaveBeenCalledWith('agent_used', expect.objectContaining({ sessionId: 'sess-1' }));
  }, 30_000);

  it('backfills the id from /reconnect on a session paired before it was persisted', async () => {
    vi.mocked(fetchCurrentPluginAuthToken).mockImplementation(async (_s, _p, _sec, onUserId) => {
      onUserId?.('usr_from_reconnect');
      return null;
    });
    await expect(boot({})).rejects.toThrow('SENTINEL_SPAWN');
    expect(vi.mocked(identifyUser).mock.calls[0][0]).toMatchObject({ userId: 'usr_from_reconnect' });
    expect(addSession).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_from_reconnect' }));
  }, 30_000);

  it('stays anonymous (no identify) when no user id is known — never falls back to the email', async () => {
    await expect(boot({})).rejects.toThrow('SENTINEL_SPAWN');
    expect(identifyUser).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledWith('agent_used', expect.anything());
  }, 30_000);
});
