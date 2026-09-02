/**
 * Regression — a burst of MCP reprovisions permanently broke the session.
 *
 * Live incident 2026-09-02 (rafaelph90.br@gmail.com). He sent "Hola" three
 * times and got "The agent hit an error and couldn't finish this turn" every
 * time, with the session unusable until restarted. His box's log:
 *
 *   19:57:20  acpRunner  — start_task → forwarding textChars=4
 *   19:57:33  integrations — injecting 14 MCP server(s): convex, vercel, jira, …
 *   19:57:33  acpClient  — reprovisionMcp → respawn to bind 14 MCP server(s)
 *   19:57:34  acpClient  — prompt ← ok stopReason=cancelled      ← his turn, killed
 *   19:57:35  acpClient  — spawn …                                ← adapter #2
 *   19:57:36  acpClient  — initialize → sending
 *   19:57:36  acpClient  — reprovisionMcp respawn failed — ACP connection closed
 *   19:57:36  acpClient  — adapter exited unexpectedly code=null signal=SIGKILL
 *   …         integrations — injecting 14 MCP server(s)  ×7 in 34 s
 *   19:58:28  acpRunner  — prompt failed: AcpClient.prompt called before start()
 *   19:58:58  acpRunner  — prompt failed: AcpClient.prompt called before start()
 *
 * Two defects, and it was NOT out of memory — his cgroup reported `oom_kill 0`
 * and 446 MB of a 3 GB cap. The SIGKILL came from our own code:
 *
 *   1. `reprovisionMcp` had no mutual exclusion. Linking several integrations
 *      in a row fired one respawn per event, and each `stop()` killed the
 *      adapter the previous respawn had started ~500 ms earlier, mid
 *      `initialize`. The last one left NO adapter.
 *   2. `runPrompt` threw "called before start()" and never restarted anything,
 *      so one adapter death made every later turn fail forever.
 *
 * It also cancelled a turn that was in flight, which is how "Hola" came back
 * `stopReason=cancelled`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const { spawnMock, state } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  state: { sessions: 0, prompts: [] as string[], promptGate: null as null | (() => void) },
}));

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

vi.mock('@agentclientprotocol/sdk', () => {
  class ClientSideConnection {
    initialize = vi.fn().mockResolvedValue({ protocolVersion: 1, agentCapabilities: {} });
    newSession = vi.fn(async () => {
      state.sessions += 1;
      return { sessionId: `sess-${state.sessions}` };
    });
    loadSession = vi.fn().mockResolvedValue(undefined);
    cancel = vi.fn();
    // A prompt that can be held open, so a test can have a turn IN FLIGHT
    // while a reprovision arrives.
    prompt = vi.fn(async () => {
      state.prompts.push('sent');
      if (state.promptGate) {
        await new Promise<void>((resolve) => {
          state.promptGate = resolve;
        });
      }
      return { stopReason: 'end_turn' };
    });
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
  return { ClientSideConnection, RequestError, ndJsonStream: vi.fn(() => ({})) };
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
  child.kill = vi.fn(() => {
    process.nextTick(() => child.emit('exit', null, 'SIGKILL'));
    return true;
  });
  return child;
}

const adapter = { command: 'node', args: ['--acp'], requiresAgentBinary: 'node' } as never;

function makeClient() {
  return new AcpClient({
    adapter,
    cwd: '/tmp/work',
    onSessionUpdate: vi.fn(),
    onRequestPermission: vi.fn(),
    mcpServers: [],
  } as never);
}

function server(name: string) {
  return { name, command: 'node', args: [name] } as never;
}

describe('AcpClient.reprovisionMcp — bursts must not kill the session', () => {
  beforeEach(() => {
    state.sessions = 0;
    state.prompts.length = 0;
    state.promptGate = null;
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => makeFakeChild());
  });

  // ⚠️ NOT asserted here: that a burst collapses to ONE respawn. Verified by
  // hand that such a test does not discriminate under this mock — the first
  // `stop()` nulls the connection, so every later call in the burst exits
  // through the `!this.connection → 'deferred'` guard and the respawn count is
  // 1 whether or not coalescing exists. Claiming it would be claiming coverage
  // that isn't there. The coalescing is still in the code (it saves real work
  // when calls DO arrive against a live connection, as they did in the
  // incident) — what the tests below pin is the part that made the session
  // unusable: the queue and the recovery.

  it('leaves a LIVE adapter after a burst (the session stays usable)', async () => {
    // The bug's real consequence: after the burst there was no adapter at all,
    // so every later turn died. This asserts the opposite directly — a prompt
    // still works afterwards.
    const client = makeClient();
    await client.start();

    await Promise.all([
      client.reprovisionMcp([server('a')]),
      client.reprovisionMcp([server('b')]),
      client.reprovisionMcp([server('c')]),
    ]);

    const res = await client.prompt('Hola');
    expect(res.stopReason).toBe('end_turn');
  });

  it('does NOT cancel a turn that is in flight — it waits for it', async () => {
    // "Hola" came back `stopReason=cancelled` because the respawn killed the
    // agent mid-answer. Sharing `promptChain` makes the respawn queue behind
    // the turn instead.
    const client = makeClient();
    await client.start();

    state.promptGate = () => undefined; // hold the next prompt open
    const turn = client.prompt('Hola');
    await new Promise((r) => setImmediate(r));
    const spawnsBefore = spawnMock.mock.calls.length;

    const reprovision = client.reprovisionMcp([server('late')]);
    await new Promise((r) => setImmediate(r));
    // The turn is still open, so nothing may have respawned yet.
    expect(spawnMock.mock.calls.length).toBe(spawnsBefore);

    // Release the turn; only then may the respawn run.
    const release = state.promptGate as unknown as () => void;
    state.promptGate = null;
    release();
    const res = await turn;
    await reprovision;

    expect(res.stopReason).toBe('end_turn'); // NOT 'cancelled'
    expect(spawnMock.mock.calls.length).toBe(spawnsBefore + 1);
  });
});

describe('AcpClient.prompt — a dead adapter is recoverable, not terminal', () => {
  beforeEach(() => {
    state.sessions = 0;
    state.prompts.length = 0;
    state.promptGate = null;
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => makeFakeChild());
  });

  it('restarts the adapter and completes the turn when it died mid-session', async () => {
    // Exactly the wall Rafael retried into: three sends, three identical
    // errors, because nothing ever restarted the adapter.
    const client = makeClient();
    await client.start();

    // Simulate the death the log recorded (SIGKILL, connection gone).
    await client.stop();

    const res = await client.prompt('Hola');
    expect(res.stopReason).toBe('end_turn');
    // It really did start a NEW adapter rather than reusing a dead one.
    expect(spawnMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('STILL throws "called before start()" when the client was never started', async () => {
    // The recovery must not paper over a genuine programming error — before
    // the first successful start there is nothing to recover.
    const client = makeClient();
    await expect(client.prompt('Hola')).rejects.toThrow(/called before start/);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
