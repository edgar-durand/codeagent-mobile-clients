/**
 * Tests for the `cli_self_update` relay command handler.
 *
 * All external side-effects (npm exec, postCliUpdateEvent, relaunch,
 * sendResult) are mocked via injected deps. The test process is never
 * killed or re-exec'd.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { HandlerContext } from '../../../src/commands/start/handlers';
import type { RemoteCommand } from '../../../src/services/command-relay.service';
import type { CommandRelayService } from '../../../src/services/command-relay.service';

// ── Mock postCliUpdateEvent so no real HTTP fires ──────────────────────────
vi.mock('../../../src/services/pairing.service', () => ({
  postCliUpdateEvent: vi.fn().mockResolvedValue({ ok: true }),
  postLinkCredential: vi.fn(),
  postAiResult: vi.fn(),
  postPreviewEvent: vi.fn(),
  postHeadroomEvent: vi.fn(),
  postBeadsEvent: vi.fn(),
  _transport: { postJson: vi.fn(), getJson: vi.fn(), postJsonAuthed: vi.fn() },
}));

import { cliSelfUpdateH } from '../../../src/commands/start/handlers';
import { postCliUpdateEvent } from '../../../src/services/pairing.service';

const postCliUpdateEventMock = vi.mocked(postCliUpdateEvent);

// ── Helpers ────────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<HandlerContext>): HandlerContext {
  const sendResult = vi.fn().mockResolvedValue(undefined);
  const relay = { sendResult } as unknown as CommandRelayService;
  return {
    outputSvc: {} as HandlerContext['outputSvc'],
    agent: {} as HandlerContext['agent'],
    historySvc: {} as HandlerContext['historySvc'],
    relay,
    runtime: {} as HandlerContext['runtime'],
    setKeepAlive: vi.fn(),
    keepAliveCtx: { inCodespace: false } as HandlerContext['keepAliveCtx'],
    pluginId: 'plug-1',
    sessionId: 'sess-1',
    agentId: 'claude',
    pluginAuthToken: 'tok-1',
    ...overrides,
  };
}

const cmd: RemoteCommand = {
  id: 'cmd-1',
  sessionId: 'sess-1',
  type: 'cli_self_update',
  payload: {},
};

// ── Build a handler with fully-mocked deps ─────────────────────────────────

interface MakeDepsOpts {
  installResult: { ok: boolean; error?: string };
  isSupervised?: boolean;
}

function makeDeps(opts: MakeDepsOpts) {
  const install = vi.fn().mockResolvedValue(opts.installResult);
  const relaunch = vi.fn();
  const isSupervised = vi.fn().mockReturnValue(opts.isSupervised ?? false);
  return { install, relaunch, isSupervised };
}

beforeEach(() => {
  postCliUpdateEventMock.mockClear();
  postCliUpdateEventMock.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ────────────────────────────────────────────────────────────────────────────

describe('cliSelfUpdateH — happy path (local, non-supervised)', () => {
  it('reports updating → relaunching, sendResult updated:true, calls relaunch', async () => {
    const ctx = makeCtx();
    const deps = makeDeps({ installResult: { ok: true }, isSupervised: false });

    const handler = cliSelfUpdateH(deps);
    await handler(ctx, cmd, {} as never);

    // postCliUpdateEvent called twice: 'updating' then 'relaunching'
    expect(postCliUpdateEventMock).toHaveBeenCalledTimes(2);
    expect(postCliUpdateEventMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ phase: 'updating', sessionId: 'sess-1' }),
    );
    expect(postCliUpdateEventMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ phase: 'relaunching' }),
    );

    expect(ctx.relay.sendResult).toHaveBeenCalledWith('cmd-1', 'completed', { updated: true });
    expect(deps.relaunch).toHaveBeenCalledOnce();
    expect(deps.install).toHaveBeenCalledOnce();
  });
});

describe('cliSelfUpdateH — npm failure', () => {
  it('reports updating → failed, sendResult updated:false, does NOT relaunch', async () => {
    const ctx = makeCtx();
    const deps = makeDeps({
      installResult: { ok: false, error: 'ECONNRESET registry timeout' },
      isSupervised: false,
    });

    const handler = cliSelfUpdateH(deps);
    await handler(ctx, cmd, {} as never);

    expect(postCliUpdateEventMock).toHaveBeenCalledTimes(2);
    expect(postCliUpdateEventMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ phase: 'updating' }),
    );
    expect(postCliUpdateEventMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ phase: 'failed', error: expect.stringContaining('ECONNRESET') }),
    );

    expect(ctx.relay.sendResult).toHaveBeenCalledWith('cmd-1', 'completed', { updated: false });
    expect(deps.relaunch).not.toHaveBeenCalled();
  });
});

describe('cliSelfUpdateH — supervised context', () => {
  it('does NOT call relaunch when isSupervised returns true (supervisor does not auto-restart)', async () => {
    const ctx = makeCtx();
    const deps = makeDeps({ installResult: { ok: true }, isSupervised: true });

    const handler = cliSelfUpdateH(deps);
    await handler(ctx, cmd, {} as never);

    // Events reported, sendResult updated:true — but relaunch NOT called.
    // The update is on disk; applies on next natural supervisor restart.
    expect(postCliUpdateEventMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ phase: 'relaunching' }),
    );
    expect(ctx.relay.sendResult).toHaveBeenCalledWith('cmd-1', 'completed', { updated: true });
    expect(deps.relaunch).not.toHaveBeenCalled();
  });
});

describe('cliSelfUpdateH — no pluginAuthToken (event POST skipped)', () => {
  it('still runs npm and calls relaunch without posting events', async () => {
    const ctx = makeCtx({ pluginAuthToken: undefined });
    const deps = makeDeps({ installResult: { ok: true }, isSupervised: false });

    const handler = cliSelfUpdateH(deps);
    await handler(ctx, cmd, {} as never);

    // No events POSTed — no token
    expect(postCliUpdateEventMock).not.toHaveBeenCalled();
    expect(ctx.relay.sendResult).toHaveBeenCalledWith('cmd-1', 'completed', { updated: true });
    expect(deps.relaunch).toHaveBeenCalledOnce();
    expect(deps.install).toHaveBeenCalledOnce();
  });
});

describe('cliSelfUpdateH — event POST failure is non-fatal', () => {
  it('continues to npm install even when postCliUpdateEvent rejects', async () => {
    postCliUpdateEventMock.mockRejectedValueOnce(new Error('network'));

    const ctx = makeCtx();
    const deps = makeDeps({ installResult: { ok: true }, isSupervised: false });

    const handler = cliSelfUpdateH(deps);
    // Must not throw even though the first POST rejects
    await expect(handler(ctx, cmd, {} as never)).resolves.toBeUndefined();

    expect(deps.install).toHaveBeenCalledOnce();
    expect(ctx.relay.sendResult).toHaveBeenCalledWith('cmd-1', 'completed', { updated: true });
    expect(deps.relaunch).toHaveBeenCalledOnce();
  });
});

describe('cliSelfUpdateH — supervised vs local decision', () => {
  it('uses isSupervised() from deps to decide the relaunch path', async () => {
    // Verify the isSupervised fn is actually called
    const ctx = makeCtx();
    const deps = makeDeps({ installResult: { ok: true }, isSupervised: false });
    const handler = cliSelfUpdateH(deps);
    await handler(ctx, cmd, {} as never);

    expect(deps.isSupervised).toHaveBeenCalledOnce();
  });

  it('relaunch receives the original process args (slice(2))', async () => {
    const ctx = makeCtx();
    const deps = makeDeps({ installResult: { ok: true }, isSupervised: false });

    // Temporarily override process.argv
    const origArgv = process.argv;
    process.argv = ['node', '/usr/local/bin/codeam', 'start', '--session', 'abc'];

    const handler = cliSelfUpdateH(deps);
    await handler(ctx, cmd, {} as never);

    expect(deps.relaunch).toHaveBeenCalledWith(['start', '--session', 'abc']);
    process.argv = origArgv;
  });
});
