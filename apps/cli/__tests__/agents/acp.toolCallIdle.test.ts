/**
 * The idle watchdog must stay SUSPENDED while a tool call is executing —
 * even across the auto-approve permission round-trip. Regression test for the
 * 2026-07-10 false-kill: a `yarn install` (a tool that runs silently for
 * ~150s) tripped "ACP prompt idle for 90s" because `requestPermission`'s
 * `finally` re-armed the watchdog unconditionally right after the tool started.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpClient, type AcpClientOptions } from '../../src/agents/acp/client';
import { createIdleTimeout, type IdleTimeout } from '../../src/agents/acp/idleTimeout';

const IDLE = 90_000;

interface ClientInternals {
  promptIdle: IdleTimeout | null;
  pendingToolCalls: Set<string>;
  trackToolCallIdle(p: unknown): void;
  buildClient(): {
    requestPermission(p: unknown): Promise<unknown>;
  };
}

function makeHarness(onPermission: () => Promise<unknown>) {
  const opts = {
    adapter: { command: 'node', args: [] },
    cwd: '/tmp',
    onSessionUpdate: () => {},
    onRequestPermission: onPermission,
  } as unknown as AcpClientOptions;
  const client = new AcpClient(opts);
  const internals = client as unknown as ClientInternals;

  let rejected = false;
  const timer = createIdleTimeout(IDLE, () => new Error('idle'));
  timer.promise.catch(() => {
    rejected = true;
  });
  internals.promptIdle = timer;
  internals.pendingToolCalls = new Set<string>();

  return { internals, rejected: () => rejected };
}

describe('AcpClient tool-call idle wiring', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stays suspended through auto-approve while a long silent tool runs, then fires on real silence', async () => {
    const approve = async () => ({ outcome: { outcome: 'selected', optionId: 'allow_always' } });
    const { internals, rejected } = makeHarness(approve);

    // 1. Tool starts (e.g. `yarn install`) → track + suspend.
    internals.trackToolCallIdle({ update: { sessionUpdate: 'tool_call', toolCallId: 't1' } });
    // 2. Adapter asks permission for it; AUTO mode approves in ms.
    await internals
      .buildClient()
      .requestPermission({ sessionId: 's', toolCall: { toolCallId: 't1' }, options: [] });

    // 3. The tool now runs SILENTLY for well past the idle window — must NOT fire.
    await vi.advanceTimersByTimeAsync(IDLE * 2);
    expect(rejected()).toBe(false);

    // 4. Tool completes → watchdog re-arms → real silence still fails fast.
    internals.trackToolCallIdle({
      update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
    });
    await vi.advanceTimersByTimeAsync(IDLE + 1);
    expect(rejected()).toBe(true);
  });

  it('re-arms after permission when NO tool is pending (genuine idle still caught)', async () => {
    const approve = async () => ({ outcome: { outcome: 'selected', optionId: 'allow_always' } });
    const { internals, rejected } = makeHarness(approve);

    // A permission with no tracked tool (e.g. a plan-mode prompt) → re-arm on answer.
    await internals
      .buildClient()
      .requestPermission({ sessionId: 's', toolCall: { toolCallId: 'x' }, options: [] });

    await vi.advanceTimersByTimeAsync(IDLE + 1);
    expect(rejected()).toBe(true);
  });
});
