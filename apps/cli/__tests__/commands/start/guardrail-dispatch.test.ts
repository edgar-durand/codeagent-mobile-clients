/**
 * Break-it 2026-09-26: the generic payload parse rejected `{action:'read'}` /
 * `{action:'write'}` (the `action` enum had no such values), so
 * `guardrail_configure` was dropped as "malformed" before its handler ran —
 * the app's Guardrails screen never loaded and every save was lost.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../src/config', () => ({ removeSession: vi.fn() }));

import { dispatchCommand, type HandlerContext } from '../../../src/commands/start/handlers';
import type { RemoteCommand } from '../../../src/services/command-relay.service';

function makeCmd(payload: Record<string, unknown>): RemoteCommand {
  return { id: 'cmd-g', sessionId: 'sess-1', type: 'guardrail_configure', payload };
}

function makeCtx(): HandlerContext {
  return {
    outputSvc: {} as HandlerContext['outputSvc'],
    agent: {} as HandlerContext['agent'],
    historySvc: {} as HandlerContext['historySvc'],
    relay: { sendResult: vi.fn().mockResolvedValue(undefined) } as unknown as HandlerContext['relay'],
    runtime: {} as HandlerContext['runtime'],
    setKeepAlive: vi.fn(),
    keepAliveCtx: { inCodespace: false } as HandlerContext['keepAliveCtx'],
    pluginId: 'p1',
    sessionId: 'sess-1',
    agentId: 'claude',
    pluginAuthToken: 't1',
  };
}

describe('guardrail_configure dispatch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('answers a read with the current policy', async () => {
    const ctx = makeCtx();
    await dispatchCommand(ctx, makeCmd({ action: 'read' }));
    expect(ctx.relay.sendResult).toHaveBeenCalledWith(
      'cmd-g',
      'completed',
      expect.objectContaining({ policy: expect.any(Object) }),
    );
  });

  it('applies a write and echoes the applied policy', async () => {
    const ctx = makeCtx();
    await dispatchCommand(ctx, makeCmd({ action: 'write', policy: {} }));
    expect(ctx.relay.sendResult).toHaveBeenCalledWith(
      'cmd-g',
      'completed',
      expect.objectContaining({ policy: expect.any(Object) }),
    );
  });
});
