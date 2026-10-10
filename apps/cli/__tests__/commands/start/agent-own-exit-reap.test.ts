/**
 * The agent's OWN exit (start.ts PTY path, `AgentService` `onExit`) must reap
 * the previews AND the standalone scratch-export tunnel before
 * `process.exit`, exactly like the SIGINT handler: an orphaned export
 * cloudflared keeps a connector on the box's named tunnel and breaks the next
 * preview. Drives the real `start()` down the PTY path (aider), captures the
 * `onExit` it hands `AgentService`, then fires it.
 */
import { describe, it, expect, vi } from 'vitest';

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
  fetchCurrentPluginAuthToken: vi.fn(async () => undefined),
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
// production API on every run (the global guard in fixtures/prod-api-guard.ts).
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

const captured: { onExit?: (code: number) => Promise<void> } = {};
vi.mock('../../../src/services/agent.service', () => ({
  AgentLaunchError: class AgentLaunchError extends Error {},
  AgentService: vi.fn(function (_runtime: unknown, opts: { onExit: (c: number) => Promise<void> }) {
    captured.onExit = opts.onExit;
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
import { getActiveSession, getActiveSessionForAgent } from '../../../src/config';
import { reapPreviewsAndExportTunnel } from '../../../src/commands/start/shutdown-tunnels';

describe('start() PTY path — the agent exits on its own', () => {
  it('awaits the preview + export-tunnel reap BEFORE process.exit', async () => {
    delete process.env.CODESPACES;
    const session = { ...fakeSessionBase, agent: 'aider' as const, pluginAuthToken: undefined };
    vi.mocked(getActiveSession).mockReturnValue(session as never);
    vi.mocked(getActiveSessionForAgent).mockReturnValue(session as never);

    await expect(start()).rejects.toThrow('SENTINEL_SPAWN');
    expect(captured.onExit).toBeTypeOf('function');

    const order: string[] = [];
    vi.mocked(reapPreviewsAndExportTunnel).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push('reaped');
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      order.push(`exit:${code}`);
    }) as never);
    try {
      await captured.onExit!(3);
    } finally {
      exitSpy.mockRestore();
    }

    expect(reapPreviewsAndExportTunnel).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['reaped', 'exit:3']);
  }, 30_000);
});
