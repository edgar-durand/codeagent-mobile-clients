/**
 * Tests for the beads_configure command handler (Task 9).
 *
 * Mirrors the headroom_configure handler test harness
 * (`handlers.headroom-agent.test.ts`) — same mock / dispatch pattern.
 *
 * Key assertions:
 * - valid actions (enable / disable / status) call `configureBeads`
 * - bad action → relay.sendResult called with 'failed'
 * - agent resolution prefers ctx.agentId over parsed payload
 * - emit chain fires postBeadsEvent with correct shape
 * - result is forwarded to relay.sendResult('completed', ...)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HandlerContext } from '../../../src/commands/start/handlers';
import type { RemoteCommand } from '../../../src/services/command-relay.service';
import type { CommandRelayService } from '../../../src/services/command-relay.service';
import type { StartCommandPayload } from '../../../src/lib/payload';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../../src/beads/configure', () => ({
  configureBeads: vi.fn().mockResolvedValue({ enabled: true, running: true }),
  probeBeadsStatus: vi.fn().mockResolvedValue({
    bdAvailable: true,
    doltAvailable: true,
    serverUp: true,
    prefix: 'test-proj',
  }),
}));

vi.mock('../../../src/beads/config-store', () => ({
  persistBeadsConfig: vi.fn(),
  readBeadsEnabled: vi.fn().mockReturnValue(true),
  beadsConfigPath: vi.fn().mockReturnValue('/tmp/.codeam/beads-config.json'),
}));

vi.mock('../../../src/beads/provisioner', () => ({
  provisionBeads: vi.fn().mockResolvedValue({
    bdAvailable: true,
    doltAvailable: true,
    serverUp: true,
    prefix: 'test-proj',
    initialized: true,
    exportEnabled: true,
    agentsWired: [],
  }),
  _provisionSeam: {},
}));

vi.mock('../../../src/beads', () => ({
  handleBeadsActionCommand: vi.fn(),
  startBeads: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../src/services/pairing.service', () => ({
  postLinkCredential: vi.fn().mockResolvedValue({ ok: true }),
  postAiResult: vi.fn().mockResolvedValue({ ok: true }),
  postPreviewEvent: vi.fn().mockResolvedValue({ ok: true }),
  postHeadroomEvent: vi.fn().mockResolvedValue({ ok: true }),
  postBeadsEvent: vi.fn().mockResolvedValue({ ok: true }),
  postBeadsProvisioning: vi.fn().mockResolvedValue({ ok: true }),
}));

// Many other services are transitively imported — mock them so module load succeeds.
vi.mock('../../../src/services/headroom/configure', () => ({
  configureHeadroom: vi.fn().mockResolvedValue({ enabled: false }),
}));

vi.mock('../../../src/commands/host-agent', () => ({
  agentIdToHeadroomKind: vi.fn().mockReturnValue('claude'),
  isHeadroomSupportedAgent: vi.fn().mockReturnValue(false),
  persistHeadroomConfig: vi.fn(),
  headroomConfigPath: vi.fn().mockReturnValue('/tmp/.codeam/headroom.json'),
  restoreAgentHeadroomConfig: vi.fn().mockResolvedValue(undefined),
  setupHeadroomForSelfHosted: vi.fn().mockResolvedValue({ enabled: false }),
}));

vi.mock('../../../src/services/headroom/stats-reporter', () => ({
  HeadroomStatsReporter: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
  mapStatsToSavings: vi.fn().mockReturnValue({ next: null }),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { handlers } from '../../../src/commands/start/handlers';
import { configureBeads } from '../../../src/beads/configure';
import { postBeadsEvent } from '../../../src/services/pairing.service';
import { provisionBeads } from '../../../src/beads/provisioner';

const configureBeadsMock = vi.mocked(configureBeads);
const postBeadsEventMock = vi.mocked(postBeadsEvent);
const provisionBeadsMock = vi.mocked(provisionBeads);

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCtx(agentId: string, opts: { pluginAuthToken?: string } = {}): HandlerContext {
  const relay = { sendResult: vi.fn().mockResolvedValue(undefined) } as unknown as CommandRelayService;
  return {
    outputSvc: {} as HandlerContext['outputSvc'],
    agent: {} as HandlerContext['agent'],
    historySvc: {} as HandlerContext['historySvc'],
    relay,
    runtime: {} as HandlerContext['runtime'],
    setKeepAlive: vi.fn(),
    keepAliveCtx: { inCodespace: false } as HandlerContext['keepAliveCtx'],
    pluginId: 'plug-1',
    sessionId: 'sess-beads-1',
    agentId,
    pluginAuthToken: opts.pluginAuthToken,
    beads: null,
  };
}

const cmd: RemoteCommand = {
  id: 'cmd-beads-1',
  sessionId: 'sess-beads-1',
  type: 'beads_configure',
  payload: {},
};

function payload(p: Record<string, unknown>): StartCommandPayload {
  return p as unknown as StartCommandPayload;
}

beforeEach(() => {
  configureBeadsMock.mockReset();
  configureBeadsMock.mockResolvedValue({ enabled: true, running: true });
  postBeadsEventMock.mockReset();
  postBeadsEventMock.mockResolvedValue({ ok: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('beads_configure handler — bad action', () => {
  it('sends failed result when action is missing', async () => {
    const ctx = makeCtx('claude');
    await handlers.beads_configure!(ctx, cmd, payload({}));
    expect(ctx.relay.sendResult).toHaveBeenCalledWith(cmd.id, 'failed', expect.objectContaining({ error: expect.any(String) }));
    expect(configureBeadsMock).not.toHaveBeenCalled();
  });

  it('sends failed result when action is an unknown string', async () => {
    const ctx = makeCtx('claude');
    await handlers.beads_configure!(ctx, cmd, payload({ action: 'badAction' }));
    expect(ctx.relay.sendResult).toHaveBeenCalledWith(cmd.id, 'failed', expect.objectContaining({ error: expect.any(String) }));
    expect(configureBeadsMock).not.toHaveBeenCalled();
  });
});

describe('beads_configure handler — valid actions', () => {
  for (const action of ['enable', 'disable', 'status'] as const) {
    it(`calls configureBeads with action='${action}'`, async () => {
      const ctx = makeCtx('claude');
      await handlers.beads_configure!(ctx, cmd, payload({ action }));
      expect(configureBeadsMock).toHaveBeenCalledTimes(1);
      const [calledAction] = configureBeadsMock.mock.calls[0];
      expect(calledAction).toBe(action);
    });

    it(`sends 'completed' result for action='${action}'`, async () => {
      const ctx = makeCtx('claude');
      await handlers.beads_configure!(ctx, cmd, payload({ action }));
      expect(ctx.relay.sendResult).toHaveBeenCalledWith(cmd.id, 'completed', expect.any(Object));
    });
  }
});

describe('beads_configure handler — status uses read-only probe (no provision)', () => {
  it('status action does NOT call provisionBeads', async () => {
    const ctx = makeCtx('claude');
    // configureBeads is fully mocked — we check that the deps.probe the handler
    // builds does NOT delegate to provisionBeads. We capture the deps arg.
    configureBeadsMock.mockImplementation(async (_action, _ctx, deps) => {
      // Invoke the probe dep to confirm it resolves without calling provisionBeads
      await deps.probe();
      return { enabled: true };
    });
    await handlers.beads_configure!(ctx, cmd, payload({ action: 'status' }));
    expect(provisionBeadsMock).not.toHaveBeenCalled();
  });

  it('enable action DOES call provisionBeads (provision dep is unchanged)', async () => {
    const ctx = makeCtx('claude');
    configureBeadsMock.mockImplementation(async (_action, _ctx, deps) => {
      await deps.provision();
      return { enabled: true };
    });
    await handlers.beads_configure!(ctx, cmd, payload({ action: 'enable' }));
    expect(provisionBeadsMock).toHaveBeenCalled();
  });
});

describe('beads_configure handler — agent resolution', () => {
  it('uses ctx.agentId when payload has no agentId', async () => {
    const ctx = makeCtx('claude');
    await handlers.beads_configure!(ctx, cmd, payload({ action: 'enable' }));
    expect(configureBeadsMock).toHaveBeenCalledTimes(1);
    const [, configureCtx] = configureBeadsMock.mock.calls[0];
    expect(configureCtx.agent).toBe('claude');
  });

  it('normalises claude_code → claude', async () => {
    const ctx = makeCtx('claude_code');
    await handlers.beads_configure!(ctx, cmd, payload({ action: 'enable' }));
    const [, configureCtx] = configureBeadsMock.mock.calls[0];
    expect(configureCtx.agent).toBe('claude');
  });

  it('ctx.agentId takes priority over stale payload agentId', async () => {
    const ctx = makeCtx('claude');
    await handlers.beads_configure!(ctx, cmd, payload({ action: 'enable', agentId: 'codex' }));
    const [, configureCtx] = configureBeadsMock.mock.calls[0];
    expect(configureCtx.agent).toBe('claude');
  });

  it('falls back to payload agentId when ctx has no agent', async () => {
    const ctx = makeCtx('');
    await handlers.beads_configure!(ctx, cmd, payload({ action: 'enable', agentId: 'codex' }));
    const [, configureCtx] = configureBeadsMock.mock.calls[0];
    expect(configureCtx.agent).toBe('codex');
  });
});

describe('beads_configure handler — emit chain', () => {
  it('does NOT call postBeadsEvent when pluginAuthToken is absent', async () => {
    const ctx = makeCtx('claude'); // no pluginAuthToken
    // Trigger the emit dep by having configureBeads call it
    configureBeadsMock.mockImplementation(async (_action, _ctx, deps) => {
      deps.emit({ type: 'beads_status', state: 'enabled' });
      return { enabled: true };
    });
    await handlers.beads_configure!(ctx, cmd, payload({ action: 'enable' }));
    // Wait for any chained promises
    await new Promise((r) => setTimeout(r, 10));
    expect(postBeadsEventMock).not.toHaveBeenCalled();
  });

  it('calls postBeadsEvent when pluginAuthToken is present', async () => {
    const ctx = makeCtx('claude', { pluginAuthToken: 'tok-123' });
    configureBeadsMock.mockImplementation(async (_action, _ctx, deps) => {
      deps.emit({ type: 'beads_status', state: 'enabled', running: true });
      return { enabled: true };
    });
    await handlers.beads_configure!(ctx, cmd, payload({ action: 'enable' }));
    // Flush the emit chain
    await new Promise((r) => setTimeout(r, 20));
    expect(postBeadsEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-beads-1',
        pluginId: 'plug-1',
        pluginAuthToken: 'tok-123',
        type: 'beads_status',
        payload: expect.objectContaining({ state: 'enabled' }),
      }),
    );
  });
});
