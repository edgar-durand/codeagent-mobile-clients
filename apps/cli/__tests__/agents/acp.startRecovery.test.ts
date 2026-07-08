/**
 * Regression — a FAILED take-control permanently wedges mobile-drive.
 *
 * `AcpClient.start()` sets `this.child` right after spawning, then performs
 * the ACP `initialize` + `newSession` handshake. If that handshake THROWS
 * (auth failure, adapter crash mid-handshake, etc.), `this.child` used to be
 * left set — and `start()` hard-throws `'AcpClient already started'` whenever
 * `this.child` is non-null. So a single failed take-control permanently
 * wedged the baton's `AcpDriver`: every subsequent `start()` for the rest of
 * the session would throw before even attempting a new handshake.
 *
 * The fix: `start()` wraps the post-spawn handshake in a try/catch. On
 * failure it kills the half-started child and resets `this.child` /
 * `this.connection` / `this.sessionId` before rethrowing the ORIGINAL error
 * unchanged — so a fresh `start()` call is retryable, and callers still see
 * the real failure reason (never swallowed).
 *
 * This test proves the recovery: a client whose FIRST handshake rejects can
 * still succeed on a SECOND `start()` once the handshake works, instead of
 * hard-throwing 'AcpClient already started'.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// Track handshake attempts across the two `new ClientSideConnection(...)`
// instantiations (one per `start()` call) so the FIRST fails and the SECOND
// succeeds — this simulates "first take-control attempt failed, second one
// (after recovery) works".
const { spawnMock, connectionState } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  connectionState: { attempt: 0 },
}));

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

vi.mock('@agentclientprotocol/sdk', () => {
  class ClientSideConnection {
    initialize: (...args: unknown[]) => Promise<unknown>;
    newSession: (...args: unknown[]) => Promise<unknown>;
    loadSession = vi.fn();
    cancel = vi.fn();
    prompt = vi.fn();
    constructor(_makeClient: unknown, _stream: unknown) {
      connectionState.attempt += 1;
      if (connectionState.attempt === 1) {
        // First take-control attempt: the handshake itself fails (e.g. the
        // adapter rejected `initialize`).
        this.initialize = vi.fn().mockRejectedValue(new Error('handshake rejected by adapter'));
        this.newSession = vi.fn();
      } else {
        // Second attempt (after recovery): handshake succeeds normally.
        this.initialize = vi.fn().mockResolvedValue({ protocolVersion: 1, agentCapabilities: {} });
        this.newSession = vi.fn().mockResolvedValue({ sessionId: 'sess-recovered' });
      }
    }
  }
  class RequestError extends Error {
    static resourceNotFound(): RequestError {
      return new RequestError('resource not found');
    }
    static invalidParams(): RequestError {
      return new RequestError('invalid params');
    }
    static internalError(): RequestError {
      return new RequestError('internal error');
    }
  }
  return {
    ClientSideConnection,
    RequestError,
    ndJsonStream: vi.fn(() => ({})),
  };
});

import { AcpClient } from '../../src/agents/acp/client';

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stdin: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.stderr = new PassThrough();
  // Real child processes deliver 'exit' asynchronously once the signal is
  // handled — simulate that so the cleanup path's listener removal is
  // actually exercised (an emit with no listeners attached is a no-op).
  child.kill = vi.fn(() => {
    process.nextTick(() => child.emit('exit', null, 'SIGKILL'));
    return true;
  });
  return child;
}

function makeAdapter() {
  return { command: 'node', args: ['--acp'], requiresAgentBinary: 'node' } as never;
}

describe('AcpClient.start — recovers from a failed handshake (baton take-control)', () => {
  beforeEach(() => {
    connectionState.attempt = 0;
    spawnMock.mockReset();
  });

  it('a second start() succeeds after the first handshake throws, instead of hard-throwing "already started"', async () => {
    const children: FakeChild[] = [];
    spawnMock.mockImplementation(() => {
      const child = makeFakeChild();
      children.push(child);
      return child;
    });

    const onUnexpectedExit = vi.fn();
    const client = new AcpClient({
      adapter: makeAdapter(),
      cwd: '/tmp/work',
      onSessionUpdate: vi.fn(),
      onRequestPermission: vi.fn(),
      onUnexpectedExit,
    });

    // First take-control attempt: the handshake rejects.
    await expect(client.start()).rejects.toThrow('handshake rejected by adapter');

    // The half-started child was killed as part of cleanup...
    expect(children).toHaveLength(1);
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    // ...but the caller's real error is never masked by an unrelated
    // "unexpected exit" callback firing from that cleanup kill (the baton's
    // onUnexpectedExit calls process.exit — it must not fire here).
    await new Promise((resolve) => setImmediate(resolve));
    expect(onUnexpectedExit).not.toHaveBeenCalled();

    // Without the fix, `this.child` would still be set here and this second
    // call would throw 'AcpClient already started' instead of attempting a
    // fresh handshake.
    const result = await client.start();
    expect(result.sessionId).toBe('sess-recovered');
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('rethrows the original handshake error unchanged (never swallowed)', async () => {
    spawnMock.mockImplementation(() => makeFakeChild());
    const client = new AcpClient({
      adapter: makeAdapter(),
      cwd: '/tmp/work',
      onSessionUpdate: vi.fn(),
      onRequestPermission: vi.fn(),
    });

    await expect(client.start()).rejects.toThrow('handshake rejected by adapter');
  });
});
