/**
 * Unit tests for the `start_task` PTY handler's agent-identity guard.
 *
 * A PTY session can't switch agents mid-session (unlike ACP, which has
 * `switchAgentH`'s equivalent guard). Before this fix, `start_task` ignored
 * `payload.agentId` entirely — a routed task naming a DIFFERENT agent would
 * silently run on the wrong one instead of failing honestly.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { HandlerContext } from '../../../src/commands/start/handlers';

vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
  execFile: vi.fn(
    (
      _cmd: string,
      _args: string[],
      cb?: (err: unknown, stdout: string, stderr: string) => void,
    ) => {
      cb?.(null, '', '');
      return { unref: vi.fn() };
    },
  ),
}));

vi.mock('../../../src/config', () => ({
  removeSession: vi.fn(),
}));

import { handlers } from '../../../src/commands/start/handlers';
import type { RemoteCommand } from '../../../src/services/command-relay.service';
import type { AgentService } from '../../../src/services/agent.service';
import type { CommandRelayService } from '../../../src/services/command-relay.service';
import type { OutputService } from '../../../src/services/output.service';

function makeCmd(type: string, payload: Record<string, unknown> = {}): RemoteCommand {
  return { id: 'test-cmd-id', sessionId: 'sess-1', type, payload };
}

function makeCtx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  const sendResult = vi.fn().mockResolvedValue(undefined);
  const newTurn = vi.fn();
  const sendCommand = vi.fn();

  return {
    outputSvc: { newTurn } as unknown as OutputService,
    agent: { sendCommand } as unknown as AgentService,
    historySvc: {} as HandlerContext['historySvc'],
    relay: { sendResult, stop: vi.fn() } as unknown as CommandRelayService,
    runtime: {} as HandlerContext['runtime'],
    setKeepAlive: vi.fn(),
    keepAliveCtx: { inCodespace: false, codespaceName: undefined },
    pluginId: 'test-plugin',
    sessionId: 'test-session',
    agentId: 'claude',
    pluginAuthToken: 'test-token',
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('start_task handler — agent-identity guard', () => {
  it('fails honestly when payload.agentId names a DIFFERENT agent than the session runs', async () => {
    const ctx = makeCtx({ agentId: 'claude' });
    const cmd = makeCmd('start_task', { prompt: 'do the thing', agentId: 'codex' });

    await handlers['start_task'](ctx, cmd, { prompt: 'do the thing', agentId: 'codex' } as never);

    expect(ctx.relay.sendResult).toHaveBeenCalledWith('test-cmd-id', 'failed', {
      error: "Switching agents isn't supported on this session.",
    });
    expect(
      (ctx.agent as unknown as { sendCommand: ReturnType<typeof vi.fn> }).sendCommand,
    ).not.toHaveBeenCalled();
    expect(
      (ctx.outputSvc as unknown as { newTurn: ReturnType<typeof vi.fn> }).newTurn,
    ).not.toHaveBeenCalled();
  });

  it('runs the prompt normally when payload.agentId matches the session agent', async () => {
    const ctx = makeCtx({ agentId: 'claude' });
    const cmd = makeCmd('start_task', { prompt: 'do the thing', agentId: 'claude' });

    await handlers['start_task'](ctx, cmd, { prompt: 'do the thing', agentId: 'claude' } as never);

    expect(ctx.relay.sendResult).not.toHaveBeenCalled();
    expect(
      (ctx.agent as unknown as { sendCommand: ReturnType<typeof vi.fn> }).sendCommand,
    ).toHaveBeenCalledWith('do the thing');
    expect(
      (ctx.outputSvc as unknown as { newTurn: ReturnType<typeof vi.fn> }).newTurn,
    ).toHaveBeenCalled();
  });

  it('runs the prompt normally when payload.agentId is absent (unrouted task)', async () => {
    const ctx = makeCtx({ agentId: 'claude' });
    const cmd = makeCmd('start_task', { prompt: 'do the thing' });

    await handlers['start_task'](ctx, cmd, { prompt: 'do the thing' } as never);

    expect(ctx.relay.sendResult).not.toHaveBeenCalled();
    expect(
      (ctx.agent as unknown as { sendCommand: ReturnType<typeof vi.fn> }).sendCommand,
    ).toHaveBeenCalledWith('do the thing');
  });
});
