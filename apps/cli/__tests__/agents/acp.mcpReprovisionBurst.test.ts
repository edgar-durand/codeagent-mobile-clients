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

// `runPrompt` self-heals the Headroom proxy before every turn. That probe is a
// real network call with a retry budget — irrelevant here, and it is what makes
// a recovery test hang instead of asserting.
vi.mock('../../src/services/headroom/proxy-supervisor', async (importOriginal) => ({
  // ⚠️ Keep the rest of the module. `client.ts` imports several symbols from
  // here; a bare factory leaves them undefined and `start()` hangs before the
  // test can assert anything.
  ...(await importOriginal<Record<string, unknown>>()),
  ensureHeadroomProxyReady: vi.fn().mockResolvedValue(undefined),
}));

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

import { AcpClient, MCP_REPROVISION_DEBOUNCE_MS } from '../../src/agents/acp/client';

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

/** Let the (test-shortened) debounce window elapse and the queued work settle. */
async function flushDebounce(): Promise<void> {
  await new Promise((r) => setTimeout(r, TEST_DEBOUNCE_MS + 5));
  await new Promise((r) => setImmediate(r));
}

/** Short enough to keep the suite fast, long enough that calls made in the same
 *  tick genuinely land inside one window. */
const TEST_DEBOUNCE_MS = 20;

function makeClient() {
  return new AcpClient({
    adapter,
    cwd: '/tmp/work',
    onSessionUpdate: vi.fn(),
    onRequestPermission: vi.fn(),
    mcpServers: [],
    mcpReprovisionDebounceMs: TEST_DEBOUNCE_MS,
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

    const reprovisions = Promise.all([
      client.reprovisionMcp([server('a')]),
      client.reprovisionMcp([server('b')]),
      client.reprovisionMcp([server('c')]),
    ]);
    await flushDebounce();
    await reprovisions;

    const res = await client.prompt('Hola');
    expect(res.stopReason).toBe('end_turn');
  });

  it('DEBOUNCES changes made one after another into a single respawn', async () => {
    // The point of the window. Adding connectors one at a time is the natural
    // way to do it, and each one used to pay a full respawn — measured at 29 s
    // on a real box (13 s to bind 14 MCP servers + 13 s to replay the
    // conversation), so ten integrations meant ten of them back to back.
    const client = makeClient();
    await client.start();
    const before = spawnMock.mock.calls.length;

    // Three changes SPACED OUT, each inside the window — the shape a burst of
    // concurrent calls would not exercise.
    const a = client.reprovisionMcp([server('a')]);
    await new Promise((r) => setTimeout(r, TEST_DEBOUNCE_MS / 4));
    const b = client.reprovisionMcp([server('a'), server('b')]);
    await new Promise((r) => setTimeout(r, TEST_DEBOUNCE_MS / 4));
    const c = client.reprovisionMcp([server('a'), server('b'), server('c')]);

    // Nothing has respawned yet: each call restarted the window.
    expect(spawnMock.mock.calls.length).toBe(before);

    await flushDebounce();
    await Promise.all([a, b, c]);

    // ONE respawn for the three changes…
    expect(spawnMock.mock.calls.length).toBe(before + 1);
    // …bound to the FINAL set, not to whichever call happened to win.
    const opts = (client as unknown as { opts: { mcpServers: { name: string }[] } }).opts;
    expect(opts.mcpServers.map((m) => m.name)).toEqual(['a', 'b', 'c']);
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
    await flushDebounce();
    // The turn is still open, so nothing may have respawned yet — the debounce
    // has already elapsed, so this is the QUEUE holding it, not the timer.
    expect(spawnMock.mock.calls.length).toBe(spawnsBefore);

    // Release the turn; only then may the respawn run.
    const release = state.promptGate as unknown as () => void;
    state.promptGate = null;
    release();
    const res = await turn;
    await new Promise((r) => setImmediate(r));
    await reprovision;

    expect(res.stopReason).toBe('end_turn'); // NOT 'cancelled'
    expect(spawnMock.mock.calls.length).toBe(spawnsBefore + 1);
  });
});

describe('AcpClient.prompt — a dead adapter is recoverable, not terminal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.sessions = 0;
    state.prompts.length = 0;
    state.promptGate = null;
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => makeFakeChild());
  });
  // ⚠️ NOT covered here: "a died adapter is restarted and the turn completes".
  // The recovery IS implemented (`runPrompt` restarts when `startedOnce`), but
  // exercising it needs a client whose adapter dies AFTER a successful start,
  // and in this harness that setup hangs inside `start()` rather than
  // asserting — a test that times out proves nothing and hides the next real
  // failure. Rather than ship a green-looking test that does not run the path,
  // it is left out and said plainly.
  //
  // It IS validated in production: the reported box recovered on 2.73.2 and its
  // log shows `reprovisionMcp <- reloaded (tools live)` where 2.73.1 had left a
  // dead adapter. The guard below still pins the half that is testable — that
  // recovery must NOT paper over a never-started client.

  it('STILL throws "called before start()" when the client was never started', async () => {
    // The recovery must not paper over a genuine programming error — before
    // the first successful start there is nothing to recover.
    const client = makeClient();
    await expect(client.prompt('Hola')).rejects.toThrow(/called before start/);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
