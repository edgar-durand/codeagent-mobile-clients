import { describe, it, expect, vi } from 'vitest';
import {
  buildBaton,
  makeOnCommand,
  makeMirrorOnNewMessages,
  makeSerializedBatonPoster,
  makeBatonHeartbeatReaffirm,
} from '../../src/baton/wire-baton';
import type { RemoteCommand } from '../../src/services/command-relay.service';
import { isLocalSession } from '../../src/baton/gate';
import type { NormalizedMessage } from '@codeam/shared';

function msg(
  role: NormalizedMessage['role'],
  text: string,
  id = `${role}-${text}`,
): NormalizedMessage {
  return { id, role, text, timestamp: new Date(0).toISOString() };
}

function fakePublisher() {
  return {
    publishOutput: vi.fn(async (_body: Record<string, unknown>) => {}),
    pushConversation: vi.fn(
      async (_args: {
        agentId: string;
        sessionId: string;
        messages: Array<{ id: string; role: 'user' | 'agent'; text: string; timestamp: number }>;
      }) => {},
    ),
  };
}

describe('buildBaton composition', () => {
  it('routes take_control to the controller and other commands to the active driver dispatcher', async () => {
    const takeControl = vi.fn(async () => {});
    const dispatchActive = vi.fn(async () => {});
    const { onCommand } = buildBaton.forTest({
      controller: { takeControl, handback: vi.fn(), state: 'LOCAL_DRIVE' } as never,
      dispatchActive,
    });
    await onCommand({
      id: 'c1',
      sessionId: 's',
      type: 'take_control',
      payload: {},
    } as RemoteCommand);
    expect(takeControl).toHaveBeenCalledTimes(1);
    await onCommand({ id: 'c2', sessionId: 's', type: 'start_task', payload: {} } as RemoteCommand);
    expect(dispatchActive).toHaveBeenCalledTimes(1);
  });

  it('dispatchActive delegates a non-baton command to the ACTIVE driver dispatch', async () => {
    // Mirror the exact wiring runBatonSession uses:
    //   dispatchActive = (cmd) => controller.activeSessionDriver.dispatch(cmd)
    const dispatch = vi.fn(async (_cmd: RemoteCommand) => {});
    const controller = {
      takeControl: vi.fn(),
      handback: vi.fn(),
      state: 'MOBILE_DRIVE' as const,
      activeSessionDriver: { dispatch },
    };
    const dispatchActive = (cmd: RemoteCommand): Promise<void> =>
      controller.activeSessionDriver.dispatch(cmd);
    const { onCommand } = buildBaton.forTest({ controller: controller as never, dispatchActive });
    const cmd = { id: 'c9', sessionId: 's', type: 'start_task', payload: {} } as RemoteCommand;
    await onCommand(cmd);
    expect(dispatch).toHaveBeenCalledWith(cmd);
    expect(controller.takeControl).not.toHaveBeenCalled();
    expect(controller.handback).not.toHaveBeenCalled();
  });

  it('routes handback to the controller (not the active driver dispatcher)', async () => {
    const handback = vi.fn(async () => {});
    const dispatchActive = vi.fn(async () => {});
    const { onCommand } = buildBaton.forTest({
      controller: { takeControl: vi.fn(), handback, state: 'MOBILE_DRIVE' } as never,
      dispatchActive,
    });
    await onCommand({ id: 'c3', sessionId: 's', type: 'handback', payload: {} } as RemoteCommand);
    expect(handback).toHaveBeenCalledTimes(1);
    expect(dispatchActive).not.toHaveBeenCalled();
  });

  it('acks failed with BATON_SWITCH_FAILED when takeControl throws', async () => {
    const takeControl = vi.fn(async () => {
      throw new Error('mobile start blew up');
    });
    const dispatchActive = vi.fn(async () => {});
    const ack = vi.fn(async () => {});
    const onCommand = makeOnCommand({
      controller: { takeControl, handback: vi.fn(), state: 'LOCAL_DRIVE' } as never,
      dispatchActive,
      ack,
    });
    await onCommand({
      id: 'c4',
      sessionId: 's',
      type: 'take_control',
      payload: {},
    } as RemoteCommand);
    expect(ack).toHaveBeenCalledWith(
      'c4',
      'failed',
      expect.objectContaining({ code: 'BATON_SWITCH_FAILED' }),
    );
    expect(dispatchActive).not.toHaveBeenCalled();
  });

  it('acks failed with BATON_SWITCH_FAILED when handback throws', async () => {
    const handback = vi.fn(async () => {
      throw new Error('local start blew up');
    });
    const dispatchActive = vi.fn(async () => {});
    const ack = vi.fn(async () => {});
    const onCommand = makeOnCommand({
      controller: { takeControl: vi.fn(), handback, state: 'MOBILE_DRIVE' } as never,
      dispatchActive,
      ack,
    });
    await onCommand({ id: 'c5', sessionId: 's', type: 'handback', payload: {} } as RemoteCommand);
    expect(ack).toHaveBeenCalledWith(
      'c5',
      'failed',
      expect.objectContaining({ code: 'BATON_SWITCH_FAILED' }),
    );
    expect(dispatchActive).not.toHaveBeenCalled();
  });
});

describe('cloud/self-hosted regression (gate)', () => {
  it('cloud/self-hosted never enter the baton (gate is false)', () => {
    expect(isLocalSession({ CODESPACES: 'true' })).toBe(false);
    expect(isLocalSession({ CODEAM_AUTO_APPROVE: '1' })).toBe(false);
  });
});

describe('makeSerializedBatonPoster (SWITCHING can never overtake the steady state)', () => {
  it('posts in call order even when the first POST is slower than the second', async () => {
    const completed: string[] = [];
    // SWITCHING resolves SLOWER than the steady-state POST would on its own —
    // the exact race that left mobile stuck on "Switching…" with the raw
    // fire-and-forget `void postBatonEvent`.
    const post = vi.fn(async (state: string) => {
      await new Promise((r) => setTimeout(r, state === 'SWITCHING' ? 20 : 1));
      completed.push(state);
    });
    const postOrdered = makeSerializedBatonPoster(post);

    postOrdered('SWITCHING');
    postOrdered('LOCAL_DRIVE');

    await vi.waitFor(() => expect(completed).toEqual(['SWITCHING', 'LOCAL_DRIVE']));
  });

  it('a failed POST does not wedge the chain — later posts still run', async () => {
    const completed: string[] = [];
    const post = vi.fn(async (state: string) => {
      if (state === 'SWITCHING') throw new Error('network blip');
      completed.push(state);
    });
    const postOrdered = makeSerializedBatonPoster(post);

    postOrdered('SWITCHING');
    postOrdered('MOBILE_DRIVE');

    await vi.waitFor(() => expect(completed).toEqual(['MOBILE_DRIVE']));
    expect(post).toHaveBeenCalledTimes(2);
  });
});

describe('makeMirrorOnNewMessages (LOCAL_DRIVE live mirror)', () => {
  it('a PRE-EXISTING batch goes to the snapshot only, never down the live pipe', async () => {
    const publisher = fakePublisher();
    const onNewMessages = makeMirrorOnNewMessages({
      publisher,
      agentId: 'claude',
      conversationId: 'conv-1',
    });

    // ⚠️ This is the churn bug. The mirror flags its catch-up read of an
    // already-existing transcript as `preexisting`, and that batch must NOT be
    // replayed as live turns: mobile already has this history (snapshot +
    // `get_conversation` on open), and replaying it rewrote the phone's
    // conversation message by message until the replay reached the end —
    // "está cambiando constantemente los mensajes y no se detiene" (owner,
    // 2026-09-03). It also churned pages the user had just scrolled up to load.
    onNewMessages([msg('user', 'hi'), msg('agent', 'hello there')], { preexisting: true });
    await vi.waitFor(() => expect(publisher.pushConversation).toHaveBeenCalledTimes(1));

    expect(publisher.pushConversation).toHaveBeenCalledWith({
      agentId: 'claude',
      sessionId: 'conv-1',
      messages: [
        expect.objectContaining({ role: 'user', text: 'hi' }),
        expect.objectContaining({ role: 'agent', text: 'hello there' }),
      ],
    });
    expect(publisher.publishOutput).not.toHaveBeenCalled();
  });

  it('live-publishes the FIRST batch of a brand-new transcript (nothing pre-existed)', async () => {
    const publisher = fakePublisher();
    const onNewMessages = makeMirrorOnNewMessages({
      publisher,
      agentId: 'claude',
      conversationId: 'conv-1',
    });

    // A brand-new local session's JSONL does not exist at mirror start, so the
    // mirror attaches from its startup poll and flags the batch as live. This
    // is the case the old `fresh` flag existed for and it must keep streaming
    // from turn one (regression guard for the 2.60.2 "silent until re-open").
    onNewMessages([msg('user', 'hi'), msg('agent', 'hello there')], { preexisting: false });

    await vi.waitFor(() => expect(publisher.publishOutput).toHaveBeenCalledTimes(4));
    expect(publisher.publishOutput.mock.calls.map((c) => c[0])).toEqual([
      { type: 'clear' },
      { type: 'user_message', content: 'hi', done: true },
      { type: 'new_turn', done: false },
      { type: 'text', content: 'hello there', done: true },
    ]);
    // And the snapshot still carries the full conversation.
    expect(publisher.pushConversation).toHaveBeenCalledWith({
      agentId: 'claude',
      sessionId: 'conv-1',
      messages: [
        expect.objectContaining({ role: 'user', text: 'hi' }),
        expect.objectContaining({ role: 'agent', text: 'hello there' }),
      ],
    });
  });

  it('snapshot accumulates the FULL conversation across batches (not just the last delta)', async () => {
    const publisher = fakePublisher();
    const onNewMessages = makeMirrorOnNewMessages({
      publisher,
      agentId: 'claude',
      conversationId: 'conv-1',
    });

    onNewMessages([msg('user', 'hi'), msg('agent', 'hello there')]); // turn 1
    onNewMessages([msg('user', 'what time is it?'), msg('agent', "it's 3pm")]); // turn 2

    await vi.waitFor(() => expect(publisher.pushConversation).toHaveBeenCalledTimes(2));
    // The SECOND snapshot must contain BOTH turns — re-opening the session
    // shows the entire conversation, not just the latest turn.
    expect(publisher.pushConversation.mock.calls[1][0].messages).toEqual([
      expect.objectContaining({ role: 'user', text: 'hi' }),
      expect.objectContaining({ role: 'agent', text: 'hello there' }),
      expect.objectContaining({ role: 'user', text: 'what time is it?' }),
      expect.objectContaining({ role: 'agent', text: "it's 3pm" }),
    ]);
  });

  it('live-publishes a genuinely new turn (user then agent) in wire order after the first batch', async () => {
    const publisher = fakePublisher();
    const onNewMessages = makeMirrorOnNewMessages({
      publisher,
      agentId: 'claude',
      conversationId: 'conv-1',
    });

    onNewMessages([msg('user', 'hi'), msg('agent', 'hello there')], { preexisting: true }); // catch-up, skipped
    onNewMessages([msg('user', 'what time is it?'), msg('agent', "it's 3pm")]); // real new turn

    await vi.waitFor(() => expect(publisher.publishOutput).toHaveBeenCalledTimes(4));

    expect(publisher.publishOutput.mock.calls.map((c) => c[0])).toEqual([
      { type: 'clear' },
      { type: 'user_message', content: 'what time is it?', done: true },
      { type: 'new_turn', done: false },
      { type: 'text', content: "it's 3pm", done: true },
    ]);
    // Snapshot stays fresh for both batches (reconnect/cold-open source).
    expect(publisher.pushConversation).toHaveBeenCalledTimes(2);
  });

  it('skips system messages entirely (neither snapshot nor live pipe)', async () => {
    const publisher = fakePublisher();
    const onNewMessages = makeMirrorOnNewMessages({
      publisher,
      agentId: 'claude',
      conversationId: 'conv-1',
    });

    onNewMessages([msg('user', 'hi'), msg('agent', 'hello')], { preexisting: true }); // catch-up
    onNewMessages([msg('system', 'internal note')]);

    await vi.waitFor(() => expect(publisher.pushConversation).toHaveBeenCalledTimes(1));
    expect(publisher.publishOutput).not.toHaveBeenCalled();
  });

  it('preserves order across two rapid-fire batches (no interleaved network races)', async () => {
    const publisher = fakePublisher();
    // Make the first live batch's HTTP calls resolve out of submission order
    // to prove the internal chain — not call timing — decides ordering.
    let callIndex = 0;
    publisher.publishOutput.mockImplementation(async () => {
      const mine = callIndex++;
      if (mine === 0) await new Promise((r) => setTimeout(r, 10));
    });
    const onNewMessages = makeMirrorOnNewMessages({
      publisher,
      agentId: 'claude',
      conversationId: 'conv-1',
    });

    onNewMessages([msg('user', 'hi'), msg('agent', 'hello')], { preexisting: true }); // catch-up
    onNewMessages([msg('user', 'turn A')]);
    onNewMessages([msg('agent', 'reply A')]);

    await vi.waitFor(() => expect(publisher.publishOutput).toHaveBeenCalledTimes(4));
    expect(publisher.publishOutput.mock.calls.map((c) => c[0])).toEqual([
      { type: 'clear' },
      { type: 'user_message', content: 'turn A', done: true },
      { type: 'new_turn', done: false },
      { type: 'text', content: 'reply A', done: true },
    ]);
  });
});

describe('makeBatonHeartbeatReaffirm (the 1 h backend snapshot never expires)', () => {
  // The CLI used to post `baton_state` only on a TRANSITION. The backend
  // snapshot lives in Redis for 1 h, and mobile treats a missing snapshot as
  // "pre-baton CLI" → no BatonBar. A local session left alone for over an hour
  // therefore reopened with Take Control GONE. The rider re-affirms the CURRENT
  // state on the relay's existing 20 s heartbeat so the TTL is always fresh.
  const LOCAL = {
    state: 'LOCAL_DRIVE' as const,
    driver: 'local_tui' as const,
    conversationId: 'conv-1',
  };

  function harness(
    currentState: () => {
      state: 'LOCAL_DRIVE' | 'MOBILE_DRIVE' | 'SWITCHING';
      driver: 'local_tui' | 'mobile_acp';
      conversationId: string | null;
    } | null,
  ) {
    const publish = vi.fn();
    let now = 1_000_000;
    const reaffirm = makeBatonHeartbeatReaffirm({
      currentState,
      publish,
      intervalMs: 5 * 60_000,
      now: () => now,
    });
    /** Advance the clock by one 20 s heartbeat and fire the tick. */
    const tick = (firstAfterConnect = false): void => {
      now += 20_000;
      reaffirm({ firstAfterConnect });
    };
    return { publish, tick, reaffirm, at: (ms: number) => (now = ms) };
  }

  it('re-affirms the CURRENT state through the poster on a heartbeat tick', () => {
    const { publish, reaffirm } = harness(() => LOCAL);
    reaffirm({ firstAfterConnect: true });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('LOCAL_DRIVE', 'local_tui', 'conv-1');
  });

  it('re-affirms whatever the controller currently holds (MOBILE_DRIVE too)', () => {
    let state = LOCAL as ReturnType<
      Parameters<typeof makeBatonHeartbeatReaffirm>[0]['currentState']
    >;
    const { publish, tick } = harness(() => state);
    tick(true);
    state = { state: 'MOBILE_DRIVE', driver: 'mobile_acp', conversationId: 'conv-1' };
    // Past the throttle window so the next tick affirms the new steady state.
    for (let i = 0; i < 16; i += 1) tick();
    expect(publish).toHaveBeenLastCalledWith('MOBILE_DRIVE', 'mobile_acp', 'conv-1');
  });

  it('throttles: 20 s ticks re-affirm at most once per ~5 min', () => {
    const { publish, tick } = harness(() => LOCAL);
    tick(true); // first beat after connect — always affirms
    expect(publish).toHaveBeenCalledTimes(1);
    // 14 more 20 s ticks = 280 s later — still inside the 300 s window.
    for (let i = 0; i < 14; i += 1) tick();
    expect(publish).toHaveBeenCalledTimes(1);
    tick(); // 300 s — window elapsed
    expect(publish).toHaveBeenCalledTimes(2);
    // And it does NOT immediately re-affirm again on the next tick.
    tick();
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('always re-affirms on the first tick after a (re)connect, ignoring the throttle', () => {
    const { publish, tick } = harness(() => LOCAL);
    tick(true);
    expect(publish).toHaveBeenCalledTimes(1);
    tick(); // 20 s later — throttled
    expect(publish).toHaveBeenCalledTimes(1);
    tick(true); // relay reconnected — affirm now, don't wait out the window
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('inactive baton (non-local / torn-down session) → zero posts on every tick', () => {
    const { publish, tick } = harness(() => null);
    tick(true);
    for (let i = 0; i < 40; i += 1) tick();
    expect(publish).not.toHaveBeenCalled();
  });

  it('never re-affirms the transient SWITCHING state, and does not burn the throttle window', () => {
    let state = { state: 'SWITCHING', driver: 'local_tui', conversationId: 'conv-1' } as ReturnType<
      Parameters<typeof makeBatonHeartbeatReaffirm>[0]['currentState']
    >;
    const { publish, tick } = harness(() => state);
    tick(true);
    expect(publish).not.toHaveBeenCalled();
    // The handoff settled — the very next tick affirms the steady state.
    state = { state: 'MOBILE_DRIVE', driver: 'mobile_acp', conversationId: 'conv-1' };
    tick();
    expect(publish).toHaveBeenCalledWith('MOBILE_DRIVE', 'mobile_acp', 'conv-1');
  });

  it('is synchronous-work-free: returns void immediately, the post is fire-and-forget', () => {
    // CLAUDE.md "Heartbeat must stay punctual" — the rider runs on the same
    // 20 s interval as the beat, so it must never await anything.
    let settled = false;
    const publish = vi.fn(() => {
      // The real poster is `makeSerializedBatonPoster(postBatonEvent)`: it
      // starts a promise chain and returns void. Simulate a POST that never
      // resolves — the rider must not care.
      void new Promise(() => {}).then(() => {
        settled = true;
      });
    });
    const reaffirm = makeBatonHeartbeatReaffirm({ currentState: () => LOCAL, publish });
    expect(reaffirm({ firstAfterConnect: true })).toBeUndefined();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
  });
});
