/**
 * Unit tests for the previewStartH reuse guard.
 *
 * When activePreviews already has a live entry for the session,
 * a second preview_start must emit preview_ready (reuse path)
 * and must NOT spawn a new dev server or emit preview_error /
 * ERR_SPAWN_FAILED.
 */
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';

// ── mocks (hoisted by Vitest before imports) ─────────────────────────────────
// vi.mock factories are hoisted to the top of the file by Vitest, so they
// cannot reference variables declared in the module body. Use vi.hoisted()
// to create shared references that are safe to use inside factories.

const { mockPostPreviewEvent, mockSpawn } = vi.hoisted(() => {
  // Spawn stub: returns a minimal process-like object so the IIFE doesn't
  // throw an unhandled rejection. In the reuse-path test we assert spawn
  // was never called; in the dead-process test the normal path calls spawn
  // and we simply check the correct event sequence.
  const fakeProcess = {
    pid: 99999,
    exitCode: null as number | null,
    killed: false,
    kill: () => true,
    on: () => fakeProcess,
    once: () => fakeProcess,
    off: () => fakeProcess,
    stdout: { on: () => {}, pipe: () => {} },
    stderr: { on: () => {}, pipe: () => {} },
    stdin: null,
    stdio: [],
    unref: () => {},
  };
  return {
    mockPostPreviewEvent: vi.fn().mockResolvedValue(undefined),
    mockSpawn: vi.fn(() => fakeProcess),
  };
});

vi.mock('../../../src/services/pairing.service', () => ({
  postLinkCredential: vi.fn().mockResolvedValue(undefined),
  postAiResult: vi.fn().mockResolvedValue(undefined),
  postPreviewEvent: mockPostPreviewEvent,
}));

vi.mock('child_process', () => ({
  spawn: mockSpawn,
  execFile: vi.fn((_cmd: string, _args: string[], cb?: (...a: unknown[]) => void) => {
    cb?.(null, '', '');
    return { unref: vi.fn() };
  }),
}));

vi.mock('../../../src/config', () => ({
  removeSession: vi.fn(),
  getConfig: vi.fn().mockReturnValue({ sessions: [] }),
}));

// ── imports after vi.mock declarations ───────────────────────────────────────

import { handlers } from '../../../src/commands/start/handlers';
import { activePreviews, registerPreview } from '../../../src/services/preview';
import type { RemoteCommand } from '../../../src/services/command-relay.service';
import type { HandlerContext } from '../../../src/commands/start/handlers';
import type { AgentService } from '../../../src/services/agent.service';
import type { CommandRelayService } from '../../../src/services/command-relay.service';
import type { StartCommandPayload } from '../../../src/lib/payload';

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Make a fake ChildProcess-like object with exitCode configurable so
 * individual tests can override it.
 */
function makeFakeProcess(exitCode: number | null): ChildProcess {
  const ee = new EventEmitter() as unknown as ChildProcess;
  Object.defineProperty(ee, 'exitCode', {
    value: exitCode,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  (ee as unknown as { kill: ReturnType<typeof vi.fn> }).kill = vi.fn();
  (ee as unknown as { unref: ReturnType<typeof vi.fn> }).unref = vi.fn();
  return ee;
}

function makeCtx(sessionId = 'sess-preview-reuse'): HandlerContext {
  return {
    agentId: 'claude',
    outputSvc: { dispose: vi.fn() } as unknown as HandlerContext['outputSvc'],
    agent: { sendRawPtyInput: vi.fn(), kill: vi.fn() } as unknown as AgentService,
    historySvc: {} as HandlerContext['historySvc'],
    relay: {
      sendResult: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    } as unknown as CommandRelayService,
    runtime: {} as HandlerContext['runtime'],
    setKeepAlive: vi.fn(),
    keepAliveCtx: { inCodespace: false, codespaceName: undefined },
    pluginId: 'test-plugin',
    sessionId,
    pluginAuthToken: 'tok-abc',
  };
}

/** A minimal preview_start command with a Next.js detection payload. */
function makePreviewStartCmd(sessionId = 'sess-preview-reuse'): RemoteCommand {
  return {
    id: 'cmd-preview-1',
    sessionId,
    type: 'preview_start',
    payload: {
      detection: {
        framework: 'Next.js',
        port: 3000,
        command: 'next',
        args: ['dev'],
        ready_pattern: 'ready',
      },
    },
  };
}

/**
 * The parsed StartCommandPayload that matches makePreviewStartCmd's payload.
 * The handler reads `detection` from this `parsed` arg (third parameter),
 * not from `cmd.payload`.
 */
function makeParsed(): StartCommandPayload {
  return {
    detection: {
      framework: 'Next.js',
      port: 3000,
      command: 'next',
      args: ['dev'],
      ready_pattern: 'ready',
    },
  } as StartCommandPayload;
}

/**
 * Flush enough microtask ticks for the fire-and-forget IIFE to run
 * through its synchronous top-of-body guard and call postPreviewEvent.
 */
async function flushIife(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('previewStartH — reuse guard', () => {
  beforeEach(() => {
    activePreviews.clear();
    mockPostPreviewEvent.mockClear();
    mockSpawn.mockClear();
  });

  afterEach(() => {
    activePreviews.clear();
  });

  it('emits preview_ready (reuse) and does NOT spawn a dev server when a live entry exists', async () => {
    // Pre-register a live preview for the session (exitCode === null = still running).
    registerPreview('sess-preview-reuse', {
      sessionId: 'sess-preview-reuse',
      devServer: makeFakeProcess(null),
      tunnel: null,
      url: 'https://already-running.trycloudflare.com',
      framework: 'Next.js',
      cwd: '/tmp/repo',
      detection: {
        framework: 'Next.js',
        port: 3000,
        command: 'next',
        args: ['dev'],
        ready_pattern: 'ready',
      },
    });

    const ctx = makeCtx();
    const cmd = makePreviewStartCmd();

    // handler is fire-and-forget; flush microtasks so the IIFE executes.
    // Pass `makeParsed()` as the third arg — previewStartH reads
    // `detection` from the `parsed` parameter, not from `cmd.payload`.
    handlers['preview_start'](ctx, cmd, makeParsed());
    await flushIife();

    // Collect all type values emitted.
    const types = mockPostPreviewEvent.mock.calls.map(
      (c) => (c[0] as { type: string }).type,
    );

    // Must emit preview_ready.
    expect(types).toContain('preview_ready');

    // preview_ready payload must point at the already-running URL.
    const readyCall = mockPostPreviewEvent.mock.calls.find(
      (c) => (c[0] as { type: string }).type === 'preview_ready',
    );
    expect(readyCall).toBeDefined();
    expect((readyCall![0] as { payload: { url: string; framework: string; port: number } }).payload).toMatchObject({
      url: 'https://already-running.trycloudflare.com',
      framework: 'Next.js',
      port: 3000,
    });

    // Must NOT emit preview_error or preview_starting.
    expect(types).not.toContain('preview_error');
    expect(types).not.toContain('preview_starting');

    // spawn() must never have been called — the reuse path returns early.
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('does NOT reuse when the registered process has already exited (exitCode !== null)', async () => {
    // Register a dead process (exitCode = 1).
    registerPreview('sess-preview-reuse', {
      sessionId: 'sess-preview-reuse',
      devServer: makeFakeProcess(1),
      tunnel: null,
      url: 'https://dead.trycloudflare.com',
      framework: 'Next.js',
      cwd: '/tmp/repo',
      detection: {
        framework: 'Next.js',
        port: 3000,
        command: 'next',
        args: ['dev'],
        ready_pattern: 'ready',
      },
    });

    const ctx = makeCtx();
    const cmd = makePreviewStartCmd();

    // The normal flow continues. spawn() returns a stub process so no
    // unhandled rejection occurs. We only check that:
    //  1. preview_starting was emitted (normal path began).
    //  2. preview_ready was NOT emitted pointing at the dead url.
    handlers['preview_start'](ctx, cmd, makeParsed());
    await flushIife();

    const types = mockPostPreviewEvent.mock.calls.map(
      (c) => (c[0] as { type: string }).type,
    );

    // Normal path starts with preview_starting.
    expect(types).toContain('preview_starting');

    // Must not emit a reuse preview_ready for the dead url.
    const reuseReady = mockPostPreviewEvent.mock.calls.find(
      (c) =>
        (c[0] as { type: string }).type === 'preview_ready' &&
        (c[0] as { payload?: { url?: string } }).payload?.url === 'https://dead.trycloudflare.com',
    );
    expect(reuseReady).toBeUndefined();
  });
});
