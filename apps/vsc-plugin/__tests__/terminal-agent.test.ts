import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OutputChannel } from 'vscode';

// The vsc-plugin module imports `vscode` at the top of multiple files.
// Tests run in plain Node, so we provide a minimal stub.
vi.mock('vscode', () => {
  return {
    window: {
      terminals: [],
      onDidCloseTerminal: () => ({ dispose: () => undefined }),
      createTerminal: () => ({ show: () => undefined, dispose: () => undefined }),
    },
    workspace: {
      workspaceFolders: undefined,
      getConfiguration: () => ({ get: <T>(_key: string, def: T) => def, update: () => Promise.resolve() }),
    },
  };
});

// Avoid real network/config singletons during pushChunk.
vi.mock('../src/services/settings.service', () => ({
  SettingsService: {
    getInstance: () => ({
      apiBaseUrl: 'http://test.invalid',
      ensurePluginId: () => 'test-plugin-id',
    }),
  },
}));
vi.mock('../src/services/command-relay.service', () => ({
  CommandRelayService: {
    getInstance: () => ({
      postJson: vi.fn().mockResolvedValue({ ok: true }),
    }),
  },
}));

// Avoid pulling ClaudeContextService side effects from rate-limit detection;
// startMonitoring doesn't touch it, but the import graph does.
vi.mock('../src/services/claude-context.service', () => ({
  ClaudeContextService: {
    getInstance: () => ({
      tryDetectRateLimit: () => undefined,
      tryDetectQuota: () => undefined,
    }),
  },
}));

import { TerminalAgentService } from '../src/services/terminal-agent.service';

function makeOutputChannel(): OutputChannel {
  const noop = () => undefined;
  // Vitest mock-stub boundary: VS Code's OutputChannel has a wider surface
  // than we use, and the test owns the lifetime of this object.
  const stub: Pick<OutputChannel, 'appendLine' | 'append' | 'name'> & Partial<OutputChannel> = {
    name: 'test',
    append: noop,
    appendLine: noop,
    clear: noop,
    show: noop,
    hide: noop,
    dispose: noop,
    replace: noop,
  };
  return stub as OutputChannel;
}

// Capture the spy type from a typed creator (which we never call) so
// we can declare `let setIntervalSpy` without an eager initial spy that
// would leak out of the suite.
const makeSetIntervalSpy = () => vi.spyOn(globalThis, 'setInterval');
type SetIntervalSpy = ReturnType<typeof makeSetIntervalSpy>;

describe('TerminalAgentService.startMonitoring', () => {
  let svc: TerminalAgentService;
  let setIntervalSpy: SetIntervalSpy;

  beforeEach(() => {
    svc = TerminalAgentService.initialize(makeOutputChannel());
    // Pretend the PTY is alive so startMonitoring proceeds past its
    // pseudoterminal-alive check. Reflect.set lets us reach the private
    // slot without a cast — we're testing the re-entry guard, not the PTY.
    Reflect.set(svc, 'pseudoterminal', { isAlive: () => true });
    setIntervalSpy = makeSetIntervalSpy();
  });

  afterEach(() => {
    svc.stopMonitoring();
    setIntervalSpy.mockRestore();
  });

  test('subsequent calls are no-ops while the tick loop is already running', () => {
    svc.startMonitoring('session-1', 'first');
    svc.startMonitoring('session-1', 'second');
    svc.startMonitoring('session-1', 'third');
    // Without the guard, each call would tear down the previous timer and
    // schedule a new one (3 setInterval invocations). With the guard, only
    // the first call proceeds — the next two return early.
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });

  test('after stopMonitoring, startMonitoring runs again', () => {
    svc.startMonitoring('session-1', 'first');
    svc.stopMonitoring();
    svc.startMonitoring('session-2', 'second');
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
  });
});
