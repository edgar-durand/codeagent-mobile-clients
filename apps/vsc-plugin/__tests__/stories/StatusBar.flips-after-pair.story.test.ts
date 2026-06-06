import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

const h = vi.hoisted(() => {
  let authToken: string | null = null;
  let recentSessions: Array<{
    sessionId: string;
    userName: string;
    userEmail: string;
    userPlan: string;
    connectedAt: number;
  }> = [];

  const appendLine = vi.fn();
  const detectInstalledAgents = vi.fn(async () => [
    { id: 'claude', name: 'Claude Code', icon: 'claude', installed: true, isTerminalAgent: true },
  ]);
  const reportStatusAgents = vi.fn();
  const reportRelayAgents = vi.fn();
  const showInformationMessage = vi.fn();
  const primeConsent = vi.fn(async () => undefined);
  const onFirstSuccess = vi.fn();
  const pushSessions = vi.fn(async () => undefined);

  const settings = {
    apiBaseUrl: 'https://api.test.local',
    showNotifications: false,
    heartbeatIntervalMs: 30_000,
    ensurePluginId: vi.fn(() => 'plugin-test'),
    getPluginAuthToken: vi.fn(() => authToken),
    setPluginAuthToken: vi.fn((token: string | null) => { authToken = token; }),
    getRecentSessions: vi.fn(() => recentSessions),
    addRecentSession: vi.fn((session: (typeof recentSessions)[number]) => {
      recentSessions = [
        session,
        ...recentSessions.filter((s) => s.sessionId !== session.sessionId),
      ].slice(0, 10);
    }),
    removeRecentSession: vi.fn((sessionId: string) => {
      recentSessions = recentSessions.filter((s) => s.sessionId !== sessionId);
    }),
    onApiBaseUrlChanged: vi.fn(),
  };

  return {
    settings,
    appendLine,
    detectInstalledAgents,
    reportStatusAgents,
    reportRelayAgents,
    showInformationMessage,
    primeConsent,
    onFirstSuccess,
    pushSessions,
    reset: () => {
      authToken = null;
      recentSessions = [];
      settings.ensurePluginId.mockClear();
      settings.getPluginAuthToken.mockClear();
      settings.setPluginAuthToken.mockClear();
      settings.getRecentSessions.mockClear();
      settings.addRecentSession.mockClear();
      settings.removeRecentSession.mockClear();
      settings.onApiBaseUrlChanged.mockClear();
      appendLine.mockClear();
      detectInstalledAgents.mockClear();
      reportStatusAgents.mockClear();
      reportRelayAgents.mockClear();
      showInformationMessage.mockClear();
      primeConsent.mockClear();
      onFirstSuccess.mockClear();
      pushSessions.mockClear();
    },
  };
});

vi.mock('vscode', () => ({
  default: {},
  window: {
    showInformationMessage: h.showInformationMessage,
  },
  env: {
    shell: '',
    clipboard: { writeText: vi.fn(async () => undefined) },
  },
  commands: { executeCommand: vi.fn(async () => undefined) },
  Uri: {
    joinPath: vi.fn((_base: unknown, ...parts: string[]) => ({ parts })),
  },
}));

vi.mock('../../src/services/settings.service', () => ({
  SettingsService: {
    getInstance: () => h.settings,
  },
}));

vi.mock('../../src/services/telemetry.service', () => ({
  capture: vi.fn(),
}));

vi.mock('../../src/services/ide-integration.service', () => ({
  IdeIntegrationService: {
    getInstance: () => ({
      detectInstalledAgents: h.detectInstalledAgents,
      clearCache: vi.fn(),
    }),
  },
}));

vi.mock('../../src/ui/status-bar', () => ({
  StatusBar: {
    getInstance: () => ({
      reportAgents: h.reportStatusAgents,
    }),
  },
}));

vi.mock('../../src/services/copilot-chat.service', () => ({
  CopilotChatService: {
    getInstance: () => ({
      primeConsent: h.primeConsent,
      onFirstSuccess: h.onFirstSuccess,
    }),
  },
}));

vi.mock('../../src/services/chat-history.service', () => ({
  ChatHistoryService: {
    getInstance: () => ({
      pushSessions: h.pushSessions,
    }),
  },
}));

vi.mock('../../src/services/file-watcher.service', () => ({
  FileWatcherService: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock('../../src/panels/panel-html', () => ({
  renderPanelHtml: () => '<html><body>story</body></html>',
}));

vi.mock('../../src/panels/remote-command-router', () => ({
  RemoteCommandRouter: vi.fn().mockImplementation(() => ({
    dispatch: vi.fn(),
  })),
}));

import { PairingService } from '../../src/services/pairing.service';
import {
  CommandRelayService,
  _testResetCommandRelay,
} from '../../src/services/command-relay.service';
import { ControllerPanelProvider } from '../../src/panels/controller-panel';

function makeLog(): vscode.OutputChannel {
  const stub: Pick<vscode.OutputChannel, 'appendLine' | 'name'> & Partial<vscode.OutputChannel> = {
    appendLine: h.appendLine,
    name: 'test',
  };
  return stub as vscode.OutputChannel;
}

function makeView(posted: Record<string, unknown>[]): vscode.WebviewView {
  const webview = {
    options: {},
    html: '',
    postMessage: vi.fn((msg: Record<string, unknown>) => {
      posted.push(msg);
      return Promise.resolve(true);
    }),
    onDidReceiveMessage: vi.fn(),
  };

  return {
    webview,
    visible: false,
    onDidChangeVisibility: vi.fn(),
  } as unknown as vscode.WebviewView;
}

function pairedSessionFrame(pluginId: string): string {
  return `event: paired_session_added\ndata: ${JSON.stringify({
    sessionId: 'session-1',
    pluginId,
    pluginAuthToken: 'token-1',
    user: {
      name: 'Nabeel Saleem',
      email: 'nabeel@example.test',
      plan: 'FREE',
    },
  })}\n`;
}

async function flushPairTick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('StatusBar story: flips after pair lifecycle', () => {
  let relay: CommandRelayService;
  let posted: Record<string, unknown>[];

  beforeEach(() => {
    h.reset();
    _testResetCommandRelay();
    const log = makeLog();
    relay = CommandRelayService.initialize(log);
    PairingService.initialize(log);
    relay._testHelpers.forceRunning(true);
    relay._testHelpers.forceConnectionState('reconnecting');
    vi.spyOn(relay, 'startPolling').mockImplementation(() => {
      relay._testHelpers.forceRunning(true);
      relay._testHelpers.markTransportSuccess('online');
    });
    vi.spyOn(relay, 'reportAgents').mockImplementation(h.reportRelayAgents);

    posted = [];
    const provider = new ControllerPanelProvider({} as vscode.Uri, log);
    provider.resolveWebviewView(
      makeView(posted),
      {} as vscode.WebviewViewResolveContext,
      {} as vscode.CancellationToken,
    );
  });

  it('moves the sidebar state from Reconnecting to Connected and rehydrates agents', async () => {
    const initialStatus = posted.find((msg) => msg.type === 'status');
    expect(initialStatus).toMatchObject({
      connected: true,
      connectionState: 'reconnecting',
      user: null,
    });

    relay._testHelpers.feedSseFrame(pairedSessionFrame('plugin-test'));
    await flushPairTick();

    const statusMessages = posted.filter((msg) => msg.type === 'status');
    expect(statusMessages[statusMessages.length - 1]).toMatchObject({
      connected: true,
      connectionState: 'online',
      sessionId: 'session-1',
      user: {
        name: 'Nabeel Saleem',
        email: 'nabeel@example.test',
        plan: 'FREE',
      },
    });
    expect(posted.find((msg) => msg.type === 'agents')).toMatchObject({
      agents: [{ id: 'claude', name: 'Claude Code', icon: 'claude' }],
    });
    expect(h.reportStatusAgents).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'claude' })]),
    );
  });

  it('keeps reconnecting on pluginId mismatch and logs the mismatch', async () => {
    relay._testHelpers.feedSseFrame(pairedSessionFrame('different-plugin'));
    await flushPairTick();

    const statusMessages = posted.filter((msg) => msg.type === 'status');
    expect(statusMessages).toHaveLength(1);
    expect(statusMessages[0]).toMatchObject({
      connected: true,
      connectionState: 'reconnecting',
      user: null,
    });
    expect(PairingService.getInstance().currentSessionId).toBeNull();
    expect(h.detectInstalledAgents).not.toHaveBeenCalled();
    expect(h.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('paired_session_added pluginId mismatch'),
    );
  });
});
