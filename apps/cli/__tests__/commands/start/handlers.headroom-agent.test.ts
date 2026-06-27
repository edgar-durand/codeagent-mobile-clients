/**
 * Regression test for the headroom_configure agent-resolution bug.
 *
 * The mobile cost-saving flow sends `{ action: 'enable' }` with NO `agentId`.
 * Previously the handler read ONLY `parsed.agentId`, so a real Claude session
 * resolved to '' → `isHeadroomSupportedAgent('')` is false → the command
 * completed with `{ supported: false }` and the app showed "Not available".
 *
 * The fix threads the running session's own agent (`ctx.agentId`, set by
 * start.ts from `session.agent`) into the handler and prefers it. These tests
 * mock `configureHeadroom` and assert the ConfigureCtx it receives carries the
 * right agent for each resolution path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HandlerContext } from '../../../src/commands/start/handlers';
import type { RemoteCommand } from '../../../src/services/command-relay.service';
import type { CommandRelayService } from '../../../src/services/command-relay.service';
import type { StartCommandPayload } from '../../../src/lib/payload';

vi.mock('../../../src/services/headroom/configure', () => ({
  configureHeadroom: vi.fn().mockResolvedValue({ enabled: true }),
}));

import { handlers } from '../../../src/commands/start/handlers';
import { configureHeadroom } from '../../../src/services/headroom/configure';

const configureHeadroomMock = vi.mocked(configureHeadroom);

function makeCtx(agentId: string): HandlerContext {
  const relay = { sendResult: vi.fn().mockResolvedValue(undefined) } as unknown as CommandRelayService;
  return {
    outputSvc: {} as HandlerContext['outputSvc'],
    agent: {} as HandlerContext['agent'],
    historySvc: {} as HandlerContext['historySvc'],
    relay,
    runtime: {} as HandlerContext['runtime'],
    setKeepAlive: vi.fn(),
    keepAliveCtx: { inCodespace: false } as HandlerContext['keepAliveCtx'],
    pluginId: 'p1',
    sessionId: 'sess-1',
    agentId,
    // pluginAuthToken intentionally unset so the handler's event POST is a no-op.
  };
}

const cmd: RemoteCommand = { id: 'cmd-1', sessionId: 'sess-1', type: 'headroom_configure', payload: {} };

function payload(p: Record<string, unknown>): StartCommandPayload {
  return p as unknown as StartCommandPayload;
}

beforeEach(() => {
  // mockReset (not clearAllMocks) — the module mock persists across tests, so
  // explicitly reset calls + re-install the resolved value for isolation.
  configureHeadroomMock.mockReset();
  configureHeadroomMock.mockResolvedValue({ enabled: true });
});

describe('headroom_configure — agent resolution', () => {
  it('uses the running session agent (ctx.agentId) when the payload has no agentId', async () => {
    const ctx = makeCtx('claude');
    await handlers.headroom_configure(ctx, cmd, payload({ action: 'enable' }));
    expect(configureHeadroomMock).toHaveBeenCalledTimes(1);
    const [action, configureCtx] = configureHeadroomMock.mock.calls[0];
    expect(action).toBe('enable');
    expect(configureCtx.agent).toBe('claude');
  });

  it('still resolves codex / copilot sessions from ctx.agentId', async () => {
    for (const a of ['codex', 'copilot']) {
      configureHeadroomMock.mockClear();
      await handlers.headroom_configure(makeCtx(a), cmd, payload({ action: 'enable' }));
      expect(configureHeadroomMock.mock.calls[0][1].agent).toBe(a);
    }
  });

  it('ctx.agentId takes priority over a stale payload agentId', async () => {
    const ctx = makeCtx('claude');
    await handlers.headroom_configure(ctx, cmd, payload({ action: 'enable', agentId: 'cursor' }));
    expect(configureHeadroomMock).toHaveBeenCalledTimes(1);
    expect(configureHeadroomMock).toHaveBeenCalledWith(
      'enable',
      expect.objectContaining({ agent: 'claude' }),
      expect.anything(),
    );
  });

  it('falls back to the payload agentId when the session has no agent (infra-only)', async () => {
    const ctx = makeCtx('');
    await handlers.headroom_configure(ctx, cmd, payload({ action: 'enable', agentId: 'codex' }));
    expect(configureHeadroomMock).toHaveBeenCalledTimes(1);
    expect(configureHeadroomMock).toHaveBeenCalledWith(
      'enable',
      expect.objectContaining({ agent: 'codex' }),
      expect.anything(),
    );
  });
});
