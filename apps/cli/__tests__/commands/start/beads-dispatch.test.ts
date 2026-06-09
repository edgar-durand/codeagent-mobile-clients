/**
 * Verifies the command-relay dispatch routes a backend-relayed
 * `beads_action` command (payload `{action, args}`) into the beads
 * orchestrator's `handleBeadsActionCommand`, and that the route is a
 * non-fatal no-op when beads never started for this session.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

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
vi.mock('../../../src/config', () => ({ removeSession: vi.fn() }));

import * as orchestrator from '../../../src/beads';
import { dispatchCommand, type HandlerContext } from '../../../src/commands/start/handlers';
import type { RemoteCommand } from '../../../src/services/command-relay.service';
import type { StartedBeads } from '../../../src/beads';

function makeCmd(type: string, payload: Record<string, unknown>): RemoteCommand {
  return { id: 'cmd-1', sessionId: 'sess-1', type, payload };
}

function makeCtx(overrides: Partial<HandlerContext> = {}): HandlerContext {
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
    pluginAuthToken: 't1',
    ...overrides,
  };
}

describe('beads_action dispatch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('routes a {action,args} payload into handleBeadsActionCommand with the live StartedBeads', async () => {
    const handle = vi
      .spyOn(orchestrator, 'handleBeadsActionCommand')
      .mockResolvedValue(undefined);
    const beads = { watcher: {}, adapter: {} } as unknown as StartedBeads;
    const ctx = makeCtx({ beads });

    await dispatchCommand(
      ctx,
      makeCmd('beads_action', { action: 'close', args: { issueId: 'bd-9', reason: 'fixed' } }),
    );

    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith(
      { kind: 'close', issueId: 'bd-9', reason: 'fixed' },
      beads,
    );
  });

  it('is a no-op when beads never started this session (no live StartedBeads)', async () => {
    const handle = vi
      .spyOn(orchestrator, 'handleBeadsActionCommand')
      .mockResolvedValue(undefined);
    const ctx = makeCtx({ beads: null });

    await dispatchCommand(ctx, makeCmd('beads_action', { action: 'close', args: { issueId: 'x' } }));

    expect(handle).not.toHaveBeenCalled();
  });

  it('drops a malformed beads_action (unknown action) without calling the orchestrator', async () => {
    const handle = vi
      .spyOn(orchestrator, 'handleBeadsActionCommand')
      .mockResolvedValue(undefined);
    const beads = { watcher: {}, adapter: {} } as unknown as StartedBeads;
    const ctx = makeCtx({ beads });

    await dispatchCommand(ctx, makeCmd('beads_action', { action: 'nope', args: {} }));

    expect(handle).not.toHaveBeenCalled();
  });

  it('swallows a thrown handleBeadsActionCommand non-fatally', async () => {
    vi.spyOn(orchestrator, 'handleBeadsActionCommand').mockRejectedValue(new Error('bd died'));
    const beads = { watcher: {}, adapter: {} } as unknown as StartedBeads;
    const ctx = makeCtx({ beads });

    await expect(
      dispatchCommand(ctx, makeCmd('beads_action', { action: 'create', args: { text: 'x' } })),
    ).resolves.toBeUndefined();
  });
});
