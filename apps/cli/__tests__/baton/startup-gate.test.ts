import { describe, it, expect, vi } from 'vitest';
import {
  makeStartupGate,
  makeMirrorOnNewMessages,
  notSignedInNotice,
  startingNotice,
} from '../../src/baton/wire-baton';
import type { RemoteCommand } from '../../src/services/command-relay.service';
import type { LocalAuthState } from '../../src/agents/strategy';

/**
 * codeagent-04jp: the local baton's relay now starts BEFORE the agent. This
 * gate decides what a phone command gets while the agent is starting, failed
 * to start, or is up but signed out — instead of the old silence (delivered,
 * never acked, "the host isn't responding").
 */

const cmd = (type: string, id = `${type}-1`): RemoteCommand =>
  ({ id, sessionId: 's', type, payload: {} }) as RemoteCommand;

function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(opts: { probeAuth?: () => Promise<LocalAuthState> } = {}) {
  const startup = deferred();
  const handle = vi.fn(async (_c: RemoteCommand) => {});
  const notify = vi.fn(async (_t: string) => {});
  const ack = vi.fn(async (_id: string, _status: string, _result: unknown) => {});
  const gate = makeStartupGate({
    handle,
    startup: startup.promise,
    agentName: 'Claude Code',
    failureMessage: (err) => `FAILED: ${(err as Error).message}`,
    probeAuth: opts.probeAuth,
    notify,
    ack,
  });
  return { startup, handle, notify, ack, gate };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('makeStartupGate — relay up before the agent', () => {
  it('a prompt sent while the agent is starting gets ONE notice, then runs once the agent is up', async () => {
    const { startup, handle, notify, gate } = setup();

    // The relay awaits each command, so a waiting prompt must NOT hold it.
    await gate(cmd('start_task', 'a'));
    await gate(cmd('start_task', 'b'));
    await flush();
    expect(handle).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(startingNotice('Claude Code'));

    startup.resolve();
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(2));
    expect(handle.mock.calls.map(([c]) => c.id)).toEqual(['a', 'b']);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('commands that do not need the agent (files, history) pass straight through while it starts', async () => {
    const { handle, notify, gate } = setup();
    await gate(cmd('get_conversation'));
    await gate(cmd('list_files'));
    expect(handle).toHaveBeenCalledTimes(2);
    expect(notify).not.toHaveBeenCalled();
  });

  it('take_control waits for the agent too — it must never stop a TUI that is still spawning', async () => {
    const { startup, handle, gate } = setup();
    await gate(cmd('take_control'));
    await flush();
    expect(handle).not.toHaveBeenCalled();
    startup.resolve();
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(1));
  });

  it('when the agent failed to start, every prompt gets the reason in chat and a failed result', async () => {
    const { startup, handle, notify, ack, gate } = setup();
    await gate(cmd('start_task', 'a'));
    startup.reject(new Error('Claude Code is required to continue.'));
    await vi.waitFor(() => expect(ack).toHaveBeenCalledTimes(1));
    await gate(cmd('start_task', 'b'));

    expect(handle).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('FAILED: Claude Code is required to continue.');
    expect(ack).toHaveBeenCalledWith(
      'a',
      'failed',
      expect.objectContaining({ code: 'AGENT_UNAVAILABLE' }),
    );
    expect(ack).toHaveBeenCalledWith(
      'b',
      'failed',
      expect.objectContaining({ code: 'AGENT_UNAVAILABLE' }),
    );
  });

  it('a signed-out agent: the prompt is NOT typed into its login screen; signing in lets the next one through', async () => {
    // 1st answer = the probe warmed when the agent came up (used by prompt a).
    const answers: LocalAuthState[] = ['not_signed_in', 'signed_in'];
    const probeAuth = vi.fn(async () => answers.shift() ?? 'signed_in');
    const { startup, handle, notify, ack, gate } = setup({ probeAuth });
    startup.resolve();
    await flush();

    await gate(cmd('start_task', 'a'));
    expect(handle).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(notSignedInNotice('Claude Code'));
    expect(ack).toHaveBeenCalledWith(
      'a',
      'failed',
      expect.objectContaining({ code: 'AGENT_NOT_SIGNED_IN' }),
    );

    // The user signs in at the terminal; the next prompt re-asks and goes through.
    await gate(cmd('start_task', 'b'));
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0][0].id).toBe('b');

    // Signed in is sticky: no more probing.
    await gate(cmd('start_task', 'c'));
    expect(probeAuth).toHaveBeenCalledTimes(2);
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it('an unreadable probe fails open — it never blocks a prompt', async () => {
    const probeAuth = vi.fn(async (): Promise<LocalAuthState> => 'unknown');
    const { startup, handle, gate } = setup({ probeAuth });
    startup.resolve();
    await flush();
    await gate(cmd('start_task'));
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('a probe that throws fails open as well', async () => {
    const probeAuth = vi.fn(async (): Promise<LocalAuthState> => {
      throw new Error('spawn ENOENT');
    });
    const { startup, handle, gate } = setup({ probeAuth });
    startup.resolve();
    await flush();
    await gate(cmd('start_task'));
    expect(handle).toHaveBeenCalledTimes(1);
  });
});

describe('makeMirrorOnNewMessages — seeded onboarding welcome (codeagent-1qhj)', () => {
  it('keeps the welcome at the head of every replace-mode snapshot', async () => {
    const publisher = {
      publishOutput: vi.fn(async (_b: Record<string, unknown>) => {}),
      pushConversation: vi.fn(async (_a: unknown) => {}),
    };
    const welcome = { id: 'onboarding-welcome', role: 'agent' as const, text: 'Welcome', timestamp: 1 };
    const onNew = makeMirrorOnNewMessages({
      publisher,
      agentId: 'claude',
      conversationId: 'conv-1',
      seed: () => [welcome],
    });
    onNew([{ id: 'u1', role: 'user', text: 'hi', timestamp: new Date(0).toISOString() }], {
      preexisting: false,
    });
    await vi.waitFor(() => expect(publisher.pushConversation).toHaveBeenCalledTimes(1));
    expect(publisher.pushConversation).toHaveBeenCalledWith({
      agentId: 'claude',
      sessionId: 'conv-1',
      messages: [welcome, expect.objectContaining({ role: 'user', text: 'hi' })],
    });
  });
});
