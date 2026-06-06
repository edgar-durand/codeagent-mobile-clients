import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { RemoteCommand } from '../../src/services/command-relay.service';

const hoisted = vi.hoisted(() => {
  const activeTerminal = {
    sendText: vi.fn(),
    show: vi.fn(),
  };
  return {
    activeTerminal,
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    executeCommand: vi.fn(),
    detectInstalledAgents: vi.fn(),
  };
});

vi.mock('vscode', () => ({
  window: {
    get activeTerminal() {
      return hoisted.activeTerminal;
    },
    showInformationMessage: hoisted.showInformationMessage,
    showWarningMessage: hoisted.showWarningMessage,
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      name: 'test',
    })),
  },
  commands: { executeCommand: hoisted.executeCommand },
  env: {
    appName: 'VS Code',
    shell: '/bin/bash',
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  },
  workspace: { workspaceFolders: [] },
}));

vi.mock('../../src/services/settings.service', () => ({
  SettingsService: {
    getInstance: () => ({
      apiBaseUrl: 'https://api.test.local',
      ensurePluginId: () => 'plugin-test',
      heartbeatIntervalMs: 30_000,
      getPluginAuthToken: () => null,
      setPluginAuthToken: vi.fn(),
      showNotifications: false,
    }),
  },
}));

vi.mock('../../src/services/telemetry.service', () => ({
  capture: vi.fn(),
}));

vi.mock('../../src/services/ide-integration.service', () => ({
  IdeIntegrationService: {
    getInstance: () => ({
      detectInstalledAgents: hoisted.detectInstalledAgents,
      clearCache: vi.fn(),
    }),
  },
}));

vi.mock('../../src/services/copilot-chat.service', () => ({
  CopilotChatService: {
    getInstance: () => ({
      setPreferredModel: vi.fn(),
      sendPrompt: vi.fn().mockResolvedValue(true),
      listAvailableModels: vi.fn().mockResolvedValue([]),
    }),
  },
}));

vi.mock('../../src/services/agent-output-monitor', () => ({
  AgentOutputMonitor: {
    getInstance: () => ({
      stopMonitoring: vi.fn(),
      queuePrompt: vi.fn(),
    }),
  },
}));

vi.mock('../../src/services/terminal-ops.service', () => ({
  TerminalOpsService: {
    getInstance: () => ({
      open: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(),
    }),
  },
}));

vi.mock('../../src/services/file-ops.service', () => ({
  FileOpsService: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
  },
}));

vi.mock('../../src/services/project-ops.service', () => ({
  ProjectOpsService: {
    listFiles: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    detectCurrentBranch: vi.fn(),
  },
}));

vi.mock('../../src/services/chat-history.service', () => ({
  ChatHistoryService: {
    getInstance: () => ({
      getSession: vi.fn(),
      setCurrentId: vi.fn(),
      pushConversation: vi.fn().mockResolvedValue(undefined),
      pushSessions: vi.fn().mockResolvedValue(undefined),
      listSessions: vi.fn(() => []),
      getCurrentId: vi.fn(() => null),
    }),
  },
}));

vi.mock('../../src/services/mcp-config-writer.service', () => ({
  McpConfigWriterService: {
    getInstance: () => ({
      configure: vi.fn(),
      status: vi.fn(),
    }),
  },
}));

import {
  CommandRelayService,
  type CommandListener,
  _testResetCommandRelay,
} from '../../src/services/command-relay.service';
import { RemoteCommandRouter } from '../../src/panels/remote-command-router';

function makeLog(): vscode.OutputChannel {
  const stub: Pick<vscode.OutputChannel, 'appendLine' | 'name'> & Partial<vscode.OutputChannel> = {
    appendLine: vi.fn(),
    name: 'test',
  };
  return stub as vscode.OutputChannel;
}

function command(id: string, prompt: string): RemoteCommand {
  return {
    id,
    sessionId: 'session-1',
    pluginId: 'plugin-test',
    type: 'start_task',
    payload: { agentId: '__terminal__:claude_code', prompt },
    status: 'pending',
    createdAt: 1,
  };
}

function sseFrame(commands: RemoteCommand[]): string {
  return `event: commands\ndata: ${JSON.stringify({ commands })}\n`;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe('Chat mobile-to-terminal dispatch story', () => {
  let relay: CommandRelayService;
  let sendResults: Array<[string, string, object]>;

  beforeEach(() => {
    _testResetCommandRelay();
    vi.clearAllMocks();
    relay = CommandRelayService.initialize(makeLog());
    sendResults = [];
    vi.spyOn(relay, 'sendResult').mockImplementation(async (id, status, result) => {
      sendResults.push([id, status, result]);
    });
    hoisted.detectInstalledAgents.mockResolvedValue([
      {
        id: '__terminal__:claude_code',
        name: 'Claude Code',
        extensionId: 'com.anthropic.claudecode',
        icon: 'claude',
        installed: true,
        isTerminalAgent: true,
      },
    ]);
  });

  it('delivers a mobile start_task prompt verbatim to the active terminal', async () => {
    const router = new RemoteCommandRouter(makeLog());
    const listener: CommandListener = {
      onCommandReceived: (received) => router.dispatch(received),
    };
    relay.addListener(listener);

    relay._testHelpers.feedSseFrame(sseFrame([command('cmd-1', 'Check this')]));
    await flushMicrotasks();

    expect(hoisted.activeTerminal.sendText).toHaveBeenCalledWith('Check this', true);
    expect(sendResults).toEqual([
      [
        'cmd-1',
        'completed',
        expect.objectContaining({ message: 'Prompt sent to active VS Code terminal' }),
      ],
    ]);
  });

  it('keeps a command pending before mount, then dispatches the reconnect replay', async () => {
    const pending = command('cmd-replay', 'Check this after reconnect');

    relay._testHelpers.feedSseFrame(sseFrame([pending]));
    expect(relay._testHelpers.wasRecentlyDispatched('cmd-replay')).toBe(false);
    expect(hoisted.activeTerminal.sendText).not.toHaveBeenCalled();

    const router = new RemoteCommandRouter(makeLog());
    relay.addListener({ onCommandReceived: (received) => router.dispatch(received) });
    relay._testHelpers.feedSseFrame(sseFrame([pending]));
    await flushMicrotasks();

    expect(hoisted.activeTerminal.sendText).toHaveBeenCalledWith(
      'Check this after reconnect',
      true,
    );
    expect(relay._testHelpers.wasRecentlyDispatched('cmd-replay')).toBe(true);
  });
});
