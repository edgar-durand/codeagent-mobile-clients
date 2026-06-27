/**
 * Unit tests for the runtime-aware handlers introduced in Task D.5:
 *   - change_model  → routes through RuntimeStrategy.changeModelInstruction()
 *   - summarize     → routes through RuntimeStrategy.summarizeInstruction()
 *   - list_models   → delegates to RuntimeStrategy.listModels()
 *
 * Each test builds a minimal mock HandlerContext; only the fields
 * exercised by the handler under test are populated.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { HandlerContext } from '../../../src/commands/start/handlers';

vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
  execFile: vi.fn((_cmd: string, _args: string[], cb?: (err: unknown, stdout: string, stderr: string) => void) => {
    cb?.(null, '', '');
    return { unref: vi.fn() };
  }),
}));

vi.mock('../../../src/config', () => ({
  removeSession: vi.fn(),
}));

import { handlers } from '../../../src/commands/start/handlers';
import type { RemoteCommand } from '../../../src/services/command-relay.service';
import type { RuntimeStrategy } from '../../../src/agents/strategy';
import type { AgentService } from '../../../src/services/agent.service';
import type { CommandRelayService } from '../../../src/services/command-relay.service';
import { removeSession } from '../../../src/config';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCmd(type: string, payload: Record<string, unknown> = {}): RemoteCommand {
  return { id: 'test-cmd-id', sessionId: 'sess-1', type, payload };
}

function makeCtx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  const sendResult = vi.fn().mockResolvedValue(undefined);
  const sendRawPtyInput = vi.fn();
  const kill = vi.fn();
  const dispose = vi.fn();
  const listModels = vi.fn().mockResolvedValue([
    { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', contextWindow: 200000 },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', contextWindow: 200000 },
  ]);
  const changeModelInstruction = vi.fn().mockImplementation((modelId: string) => ({
    type: 'pty' as const,
    ptyInput: `/model ${modelId}\r`,
  }));
  const summarizeInstruction = vi.fn().mockImplementation((mode: string) => ({
    ptyInput: mode === 'auto' ? '/compact --auto\r' : '/compact\r',
  }));

  return {
    outputSvc: { dispose } as unknown as HandlerContext['outputSvc'],
    agent: { sendRawPtyInput, kill } as unknown as AgentService,
    historySvc: {} as HandlerContext['historySvc'],
    relay: { sendResult, stop: vi.fn() } as unknown as CommandRelayService,
    runtime: {
      listModels,
      changeModelInstruction,
      summarizeInstruction,
    } as unknown as RuntimeStrategy,
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

// ─── change_model ────────────────────────────────────────────────────────────

describe('change_model handler', () => {
  it('sends /model command to PTY via runtime', async () => {
    const ctx = makeCtx();
    const cmd = makeCmd('change_model', { modelId: 'claude-opus-4-7' });

    await handlers['change_model'](ctx, cmd, {} as never);

    expect(ctx.runtime.changeModelInstruction).toHaveBeenCalledWith('claude-opus-4-7');
    expect((ctx.agent as unknown as { sendRawPtyInput: ReturnType<typeof vi.fn> }).sendRawPtyInput)
      .toHaveBeenCalledWith('/model claude-opus-4-7\r');
    expect(ctx.relay.sendResult).toHaveBeenCalledWith('test-cmd-id', 'completed', {});
  });

  it('fails when modelId is missing', async () => {
    const ctx = makeCtx();
    const cmd = makeCmd('change_model', {});

    await handlers['change_model'](ctx, cmd, {} as never);

    expect(ctx.relay.sendResult).toHaveBeenCalledWith('test-cmd-id', 'failed', { error: 'modelId required' });
    expect((ctx.agent as unknown as { sendRawPtyInput: ReturnType<typeof vi.fn> }).sendRawPtyInput)
      .not.toHaveBeenCalled();
  });

  it('fails when modelId is not a string', async () => {
    const ctx = makeCtx();
    const cmd = makeCmd('change_model', { modelId: 42 });

    await handlers['change_model'](ctx, cmd, {} as never);

    expect(ctx.relay.sendResult).toHaveBeenCalledWith('test-cmd-id', 'failed', { error: 'modelId required' });
  });

  it('fails with restart-mode instruction (Phase 1 not supported)', async () => {
    const ctx = makeCtx();
    // Override runtime to return restart-type instruction
    vi.mocked(ctx.runtime.changeModelInstruction).mockReturnValueOnce({
      type: 'restart',
      restartArgs: ['--model', 'new-model'],
    });
    const cmd = makeCmd('change_model', { modelId: 'some-model' });

    await handlers['change_model'](ctx, cmd, {} as never);

    expect(ctx.relay.sendResult).toHaveBeenCalledWith(
      'test-cmd-id',
      'failed',
      { error: 'restart-mode change_model not supported in Phase 1' },
    );
  });

  it('fails when pty instruction has no ptyInput', async () => {
    const ctx = makeCtx();
    vi.mocked(ctx.runtime.changeModelInstruction).mockReturnValueOnce({
      type: 'pty',
      // ptyInput intentionally omitted
    });
    const cmd = makeCmd('change_model', { modelId: 'claude-opus-4-7' });

    await handlers['change_model'](ctx, cmd, {} as never);

    expect(ctx.relay.sendResult).toHaveBeenCalledWith(
      'test-cmd-id',
      'failed',
      { error: 'no pty input for this agent' },
    );
  });
});

// ─── summarize ───────────────────────────────────────────────────────────────

describe('summarize handler', () => {
  it('sends /compact when mode=normal', async () => {
    const ctx = makeCtx();
    const cmd = makeCmd('summarize', { mode: 'normal' });

    await handlers['summarize'](ctx, cmd, {} as never);

    expect(ctx.runtime.summarizeInstruction).toHaveBeenCalledWith('normal');
    expect((ctx.agent as unknown as { sendRawPtyInput: ReturnType<typeof vi.fn> }).sendRawPtyInput)
      .toHaveBeenCalledWith('/compact\r');
    expect(ctx.relay.sendResult).toHaveBeenCalledWith('test-cmd-id', 'completed', {});
  });

  it('sends auto compact instruction when mode=auto', async () => {
    const ctx = makeCtx();
    const cmd = makeCmd('summarize', { mode: 'auto' });

    await handlers['summarize'](ctx, cmd, {} as never);

    expect(ctx.runtime.summarizeInstruction).toHaveBeenCalledWith('auto');
    expect((ctx.agent as unknown as { sendRawPtyInput: ReturnType<typeof vi.fn> }).sendRawPtyInput)
      .toHaveBeenCalledWith('/compact --auto\r');
    expect(ctx.relay.sendResult).toHaveBeenCalledWith('test-cmd-id', 'completed', {});
  });

  it('defaults to normal mode when mode param is absent', async () => {
    const ctx = makeCtx();
    const cmd = makeCmd('summarize', {});

    await handlers['summarize'](ctx, cmd, {} as never);

    expect(ctx.runtime.summarizeInstruction).toHaveBeenCalledWith('normal');
  });
});

// ─── list_models ─────────────────────────────────────────────────────────────

describe('list_models handler', () => {
  it('forwards runtime.listModels() result to relay', async () => {
    const ctx = makeCtx();
    const cmd = makeCmd('list_models');

    await handlers['list_models'](ctx, cmd, {} as never);

    expect(ctx.runtime.listModels).toHaveBeenCalled();
    expect(ctx.relay.sendResult).toHaveBeenCalledWith(
      'test-cmd-id',
      'completed',
      {
        models: [
          { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', contextWindow: 200000 },
          { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', contextWindow: 200000 },
        ],
      },
    );
  });

  it('returns whatever the runtime provides (not a hardcoded list)', async () => {
    const ctx = makeCtx();
    const customModels = [{ id: 'codex-model-x', label: 'Codex X', contextWindow: 128000 }];
    vi.mocked(ctx.runtime.listModels).mockResolvedValueOnce(customModels as never);
    const cmd = makeCmd('list_models');

    await handlers['list_models'](ctx, cmd, {} as never);

    expect(ctx.relay.sendResult).toHaveBeenCalledWith(
      'test-cmd-id',
      'completed',
      { models: customModels },
    );
  });
});

// ─── session_terminated ─────────────────────────────────────────────────────

describe('session_terminated handler', () => {
  it('acknowledges delete before tearing down the local session', async () => {
    const ctx = makeCtx();
    const cmd = makeCmd('session_terminated');
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    }) as never);

    await expect(handlers['session_terminated'](ctx, cmd, {} as never))
      .rejects.toThrow('process.exit:0');

    expect(ctx.relay.sendResult).toHaveBeenCalledWith('test-cmd-id', 'success', { ok: true });
    expect(removeSession).toHaveBeenCalledWith('test-session');
    expect((ctx.agent as unknown as { kill: ReturnType<typeof vi.fn> }).kill).toHaveBeenCalled();
    expect((ctx.outputSvc as unknown as { dispose: ReturnType<typeof vi.fn> }).dispose).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });
});
