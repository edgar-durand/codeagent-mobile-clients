import { describe, it, expect, vi } from 'vitest';
import { buildBaton, makeOnCommand, makeMirrorOnNewMessages } from '../../src/baton/wire-baton';
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

describe('makeMirrorOnNewMessages (LOCAL_DRIVE live mirror)', () => {
  it('re-arm: pushes the conversation snapshot, but skips the live pipe on the first (catch-up) batch', async () => {
    const publisher = fakePublisher();
    const onNewMessages = makeMirrorOnNewMessages({
      publisher,
      agentId: 'claude',
      conversationId: 'conv-1',
      fresh: false, // handback re-arm — mobile already has the history
    });

    // TranscriptMirror's first call after start() reports the whole
    // pre-existing history — on a RE-ARM this must NOT replay live.
    onNewMessages([msg('user', 'hi'), msg('agent', 'hello there')]);
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

  it('fresh: live-publishes from the very first batch (mobile has nothing yet)', async () => {
    const publisher = fakePublisher();
    const onNewMessages = makeMirrorOnNewMessages({
      publisher,
      agentId: 'claude',
      conversationId: 'conv-1',
      fresh: true, // begin() — brand-new local session
    });

    onNewMessages([msg('user', 'hi'), msg('agent', 'hello there')]);

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
      fresh: true,
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
      fresh: false,
    });

    onNewMessages([msg('user', 'hi'), msg('agent', 'hello there')]); // catch-up, skipped
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
      fresh: false,
    });

    onNewMessages([msg('user', 'hi'), msg('agent', 'hello')]); // catch-up
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
      fresh: false,
    });

    onNewMessages([msg('user', 'hi'), msg('agent', 'hello')]); // catch-up
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
