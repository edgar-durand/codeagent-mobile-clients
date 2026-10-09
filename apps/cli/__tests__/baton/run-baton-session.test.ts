import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RemoteCommand } from '../../src/services/command-relay.service';

/**
 * runBatonSession composition (codeagent-04jp / codeagent-1qhj).
 *
 * The 2026-10-02 local-session incident: the relay started only AFTER
 * `controller.begin()` — which spawns the native TUI and could wait forever on
 * the Claude install prompt, or end the process when Claude couldn't be
 * installed. The phone saw its prompts delivered and never acked. These tests
 * drive the REAL composition root with the native TUI start held open.
 */

const h = vi.hoisted(() => {
  const state = {
    relay: null as null | {
      onCommand: (cmd: RemoteCommand) => Promise<void>;
      start: ReturnType<typeof import('vitest').vi.fn>;
      sendResult: ReturnType<typeof import('vitest').vi.fn>;
    },
    nativeStart: null as null | {
      resolve: (id: string | null) => void;
      reject: (err: unknown) => void;
    },
    nativeDispatch: null as null | ReturnType<typeof import('vitest').vi.fn>,
    publishOutput: null as null | ReturnType<typeof import('vitest').vi.fn>,
    pushConversation: null as null | ReturnType<typeof import('vitest').vi.fn>,
    welcome: null as null | ReturnType<typeof import('vitest').vi.fn>,
  };
  return { state };
});

vi.mock('../../src/services/command-relay.service', async () => {
  const { vi: v } = await import('vitest');
  class CommandRelayService {
    start = v.fn();
    sendResult = v.fn(async () => {});
    setOnSessionGone = v.fn();
    constructor(_pluginId: string, onCommand: (cmd: RemoteCommand) => Promise<void>) {
      h.state.relay = { onCommand, start: this.start, sendResult: this.sendResult };
    }
  }
  return { CommandRelayService, stopRelayWithGoodbye: v.fn(async () => {}) };
});

vi.mock('../../src/baton/native-tui-driver', async () => {
  const { vi: v } = await import('vitest');
  class NativeTuiDriver {
    kind = 'local_tui';
    dispatch = v.fn(async () => {});
    stop = v.fn(async () => {});
    whenSafeToYield = v.fn(async () => {});
    handlePtyData = v.fn();
    constructor() {
      h.state.nativeDispatch = this.dispatch;
    }
    start(): Promise<string | null> {
      return new Promise((resolve, reject) => {
        h.state.nativeStart = { resolve, reject };
      });
    }
  }
  return { NativeTuiDriver };
});

vi.mock('../../src/baton/acp-driver', async () => {
  const { vi: v } = await import('vitest');
  class AcpDriver {
    kind = 'mobile_acp';
    dispatch = v.fn(async () => {});
    start = v.fn(async () => 'acp-id');
    stop = v.fn(async () => {});
    whenSafeToYield = v.fn(async () => {});
  }
  return { AcpDriver };
});

vi.mock('../../src/baton/transcript-mirror', async () => {
  const { vi: v } = await import('vitest');
  class TranscriptMirror {
    start = v.fn();
    stop = v.fn();
    poke = v.fn();
  }
  return { TranscriptMirror };
});

vi.mock('../../src/agents/acp/publisher', async () => {
  const { vi: v } = await import('vitest');
  class AcpPublisher {
    publishOutput = v.fn(async () => {});
    pushConversation = v.fn(async () => {});
    constructor() {
      h.state.publishOutput = this.publishOutput;
      h.state.pushConversation = this.pushConversation;
    }
  }
  return { AcpPublisher };
});

vi.mock('../../src/agents/acp/client', async () => {
  class AcpClient {}
  return { AcpClient };
});

vi.mock('../../src/agents/acp/onboarding', async () => {
  const { vi: v } = await import('vitest');
  const maybeSendOnboardingWelcome = v.fn(async () => {});
  h.state.welcome = maybeSendOnboardingWelcome;
  return { maybeSendOnboardingWelcome };
});

vi.mock('../../src/agents/registry', () => ({
  createRuntimeStrategy: () => ({
    meta: { id: 'claude', name: 'claude', displayName: 'Claude Code' },
    probeLocalAuth: async () => 'signed_in',
  }),
}));

vi.mock('../../src/services/pairing.service', () => ({
  fetchCurrentPluginAuthToken: async () => null,
  postBatonEvent: async () => undefined,
}));

vi.mock('../../src/ui/banner', () => ({
  showInfo: () => undefined,
  showSuccess: () => undefined,
  showRelayNotice: () => undefined,
}));

import { runBatonSession } from '../../src/baton/wire-baton';

const opts = {
  agent: 'claude' as const,
  sessionId: 'sess-1',
  pluginId: 'plug-1',
  pluginAuthToken: 'tok',
  cwd: '/tmp/proj',
  adapter: { command: 'x', args: [], requiresAgentBinary: 'claude' },
};

const startTask = (id: string): RemoteCommand =>
  ({ id, sessionId: 'sess-1', type: 'start_task', payload: { prompt: 'hi' } }) as RemoteCommand;

async function boot(): Promise<void> {
  void runBatonSession(opts as never);
  await vi.waitFor(() => expect(h.state.nativeStart).not.toBeNull());
}

describe('runBatonSession — relay first (codeagent-04jp)', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    h.state.relay = null;
    h.state.nativeStart = null;
    h.state.welcome?.mockClear();
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    consoleError.mockRestore();
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.removeAllListeners(sig);
  });

  it('starts the relay while the native TUI is still spawning, and holds the prompt until it is up', async () => {
    await boot();
    // THE regression: before the fix start() ran only after begin() resolved.
    expect(h.state.relay?.start).toHaveBeenCalledTimes(1);

    // Returns at once: a waiting prompt must not hold the relay's dispatch.
    await h.state.relay!.onCommand(startTask('c1'));
    await vi.waitFor(() =>
      expect(h.state.publishOutput).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'text',
          content: expect.stringContaining('still starting'),
        }),
      ),
    );
    expect(h.state.nativeDispatch).not.toHaveBeenCalled();

    h.state.nativeStart!.resolve('conv-1');
    await vi.waitFor(() =>
      expect(h.state.nativeDispatch).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' })),
    );
  });

  it('when the agent cannot launch, the session stays up and answers prompts with the reason', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      await boot();
      h.state.nativeStart!.reject(
        new Error('Claude Code could not be launched. Claude Code is required to continue.'),
      );
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
      await h.state.relay!.onCommand(startTask('c2'));

      expect(h.state.publishOutput).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'text',
          content: expect.stringContaining('Claude Code is required to continue.'),
        }),
      );
      expect(h.state.relay!.sendResult).toHaveBeenCalledWith(
        'c2',
        'failed',
        expect.objectContaining({ code: 'AGENT_UNAVAILABLE' }),
      );
      expect(h.state.nativeDispatch).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  it('sends the first-pair onboarding welcome once the TUI is up (codeagent-1qhj)', async () => {
    await boot();
    expect(h.state.welcome).not.toHaveBeenCalled();
    h.state.nativeStart!.resolve('conv-9');
    await vi.waitFor(() => expect(h.state.welcome).toHaveBeenCalledTimes(1));
    const arg = h.state.welcome!.mock.calls[0][0] as {
      sessionId: string;
      cwd: string;
      history: { appendAgentInitiatedReply: (t: string) => void; flush: () => Promise<void> };
    };
    expect(arg.sessionId).toBe('sess-1');
    expect(arg.cwd).toBe('/tmp/proj');

    // The welcome is persisted as the opening conversation's content.
    arg.history.appendAgentInitiatedReply('Welcome!');
    await arg.history.flush();
    expect(h.state.pushConversation).toHaveBeenCalledWith({
      agentId: 'claude',
      sessionId: 'conv-9',
      messages: [expect.objectContaining({ role: 'agent', text: 'Welcome!' })],
    });
  });
});
