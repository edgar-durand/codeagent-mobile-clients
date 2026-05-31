import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentService } from '../../src/services/agent.service';
import type { IPtyStrategy } from '../../src/services/pty/types';
import type { RuntimeStrategy } from '../../src/agents/strategy';

/**
 * Covers the agent-agnostic serialised-submission queue added to
 * AgentService — see the class comment block on `agentBusy /
 * lastAgentDataAt / QUIET_MS` for the WHY. The bug it fixes:
 *
 *   1. Mobile sends comment A → start_task → CLI writes prompt + \r.
 *   2. Agent is still rendering response to a previous turn — Claude
 *      Code's input field accepts the write as bracketed-paste, the
 *      \r is consumed as paste content, prompt sits as
 *      "[Pasted text #N]" forever.
 *   3. The user sees 7 paste markers piled up, terminal "blocked".
 *
 * The fix queues subsequent prompts and only drains them after
 * QUIET_MS of PTY silence (the agent has finished its turn).
 */
describe('AgentService — serialised submission queue', () => {
  let writeSpy: ReturnType<typeof vi.fn<(data: string | Buffer) => void>>;
  let strategy: IPtyStrategy;
  let agent: AgentService;
  let strategyOpts: { onData: (d: string) => void; onExit: (c: number) => void };

  beforeEach(() => {
    vi.useFakeTimers();
    writeSpy = vi.fn<(data: string | Buffer) => void>();
    strategy = {
      spawn: vi.fn(),
      write: writeSpy,
      kill: vi.fn(),
      dispose: vi.fn(),
    };
    const runtime = {
      meta: { id: 'claude', displayName: 'Claude Code' },
    } as unknown as RuntimeStrategy;
    agent = new AgentService(runtime, {
      cwd: '/tmp/test',
      onExit: vi.fn(),
    });
    // The constructor stores `strategyOpts` privately — grab the
    // reference so the test can synthesise PTY output the same way
    // a real strategy would. This mirrors the injection pattern used
    // in pty-sigint.test.ts.
    strategyOpts = (agent as unknown as {
      strategyOpts: { onData: (d: string) => void; onExit: (c: number) => void };
    }).strategyOpts;
    Object.assign(agent, { strategy, agentReady: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('first sendCommand submits immediately', () => {
    agent.sendCommand('hello');
    expect(writeSpy).toHaveBeenCalledWith('hello');
    // The trailing \r fires after 50 ms (lineCount === 1).
    vi.advanceTimersByTime(60);
    expect(writeSpy).toHaveBeenCalledWith('\r');
  });

  test('second sendCommand while agent is busy is queued, not written', () => {
    agent.sendCommand('first');
    expect(writeSpy).toHaveBeenCalledWith('first');
    writeSpy.mockClear();

    // Agent is mid-response — simulate output landing.
    strategyOpts.onData('some agent output');

    // Second prompt arrives while the agent is still busy.
    agent.sendCommand('second');
    // It MUST NOT be written to the PTY yet — that's the whole
    // point of the queue.
    expect(writeSpy).not.toHaveBeenCalledWith('second');
  });

  test('queued prompt drains after QUIET_MS of PTY silence', () => {
    agent.sendCommand('first');
    strategyOpts.onData('streaming response chunk 1');
    agent.sendCommand('second');
    agent.sendCommand('third');

    writeSpy.mockClear();

    // Keep emitting data to model an ongoing response — queue stays
    // dormant.
    vi.advanceTimersByTime(1000);
    strategyOpts.onData('streaming response chunk 2');
    vi.advanceTimersByTime(1000);
    expect(writeSpy).not.toHaveBeenCalledWith('second');

    // Now the agent goes silent — wait QUIET_MS (1500 ms) + slack.
    vi.advanceTimersByTime(1600);
    expect(writeSpy).toHaveBeenCalledWith('second');
    // Drain pacing: the next prompt's \r is scheduled 50 ms later.
    vi.advanceTimersByTime(60);
    expect(writeSpy).toHaveBeenCalledWith('\r');
  });

  test('subsequent queued prompts drain one-at-a-time, not in a burst', () => {
    agent.sendCommand('first');
    strategyOpts.onData('response to first');
    agent.sendCommand('second');
    agent.sendCommand('third');
    writeSpy.mockClear();

    // Agent finishes first turn.
    vi.advanceTimersByTime(1600);
    expect(writeSpy).toHaveBeenCalledWith('second');
    // `third` must NOT have fired yet — it waits for the agent to
    // start, then finish, responding to `second`.
    expect(writeSpy).not.toHaveBeenCalledWith('third');

    // Agent starts responding to `second`, then goes idle.
    strategyOpts.onData('response to second');
    vi.advanceTimersByTime(1600);
    expect(writeSpy).toHaveBeenCalledWith('third');
  });

  test('quiet timer re-arms while new PTY data keeps arriving', () => {
    agent.sendCommand('first');
    agent.sendCommand('queued');
    writeSpy.mockClear();

    // Burst of output spread over 4 seconds — agent IS busy.
    for (let i = 0; i < 4; i++) {
      strategyOpts.onData(`chunk ${i}`);
      vi.advanceTimersByTime(800);
    }
    // None of the queued prompt should have fired — every 800 ms of
    // activity resets the quiet window.
    expect(writeSpy).not.toHaveBeenCalledWith('queued');

    // Stop emitting; agent goes idle.
    vi.advanceTimersByTime(1600);
    expect(writeSpy).toHaveBeenCalledWith('queued');
  });

  test('cold-boot buffered inputs drain one-at-a-time too', () => {
    // Simulate "agent not ready yet" by toggling the flag back.
    Object.assign(agent, { agentReady: false });
    agent.sendCommand('boot-1');
    agent.sendCommand('boot-2');
    agent.sendCommand('boot-3');

    // First PTY byte arrives → drainPending after 250 ms tick.
    strategyOpts.onData('agent has rendered');
    vi.advanceTimersByTime(260);

    expect(writeSpy).toHaveBeenCalledWith('boot-1');
    expect(writeSpy).not.toHaveBeenCalledWith('boot-2');
    expect(writeSpy).not.toHaveBeenCalledWith('boot-3');

    // Agent answers boot-1, then goes idle.
    strategyOpts.onData('response');
    vi.advanceTimersByTime(1600);
    expect(writeSpy).toHaveBeenCalledWith('boot-2');
    expect(writeSpy).not.toHaveBeenCalledWith('boot-3');

    strategyOpts.onData('response');
    vi.advanceTimersByTime(1600);
    expect(writeSpy).toHaveBeenCalledWith('boot-3');
  });

  test('multi-line prompt wraps in bracketed-paste then sends \\r outside the bracket', () => {
    const multiLine = 'line 1\nline 2\nline 3\nline 4';
    agent.sendCommand(multiLine);
    // Multi-line writes are wrapped in bracketed-paste markers so the
    // trailing `\r` is interpreted as Submit (outside the paste),
    // not as paste content.
    expect(writeSpy).toHaveBeenCalledWith(`\x1b[200~${multiLine}\x1b[201~`);
    // \r is delayed 80 ms after the bracket closes.
    vi.advanceTimersByTime(50);
    expect(writeSpy).not.toHaveBeenCalledWith('\r');
    vi.advanceTimersByTime(50);
    expect(writeSpy).toHaveBeenCalledWith('\r');
  });
});
