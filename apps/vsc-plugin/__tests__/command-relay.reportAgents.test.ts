import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

vi.mock('vscode', () => ({
  default: {},
  window: { showWarningMessage: vi.fn().mockResolvedValue(undefined) },
  commands: { executeCommand: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../src/services/settings.service', () => ({
  SettingsService: {
    getInstance: () => ({
      apiBaseUrl: 'https://api.test.local',
      ensurePluginId: () => 'plugin-test',
      heartbeatIntervalMs: 30_000,
      getPluginAuthToken: () => null,
      setPluginAuthToken: vi.fn(),
    }),
  },
}));

vi.mock('../src/services/telemetry.service', () => ({
  capture: vi.fn(),
}));

import {
  CommandRelayService,
  _testResetCommandRelay,
} from '../src/services/command-relay.service';

function makeLog(): vscode.OutputChannel {
  const stub: Pick<vscode.OutputChannel, 'appendLine' | 'name'> & Partial<vscode.OutputChannel> = {
    appendLine: vi.fn(),
    name: 'test',
  };
  return stub as vscode.OutputChannel;
}

describe('CommandRelayService.reportAgents wire shape', () => {
  let relay: CommandRelayService;

  beforeEach(() => {
    _testResetCommandRelay();
    relay = CommandRelayService.initialize(makeLog());
  });

  it('maps isTerminalAgent → isTerminal in the POST body', async () => {
    const postJson = vi
      .spyOn(relay as unknown as { postJson: ReturnType<typeof vi.fn> }, 'postJson')
      .mockResolvedValue({});
    relay.reportAgents([
      { id: 'claude', name: 'Claude Code', icon: 'claude', installed: true, isTerminalAgent: true },
      { id: 'copilot', name: 'GitHub Copilot', icon: 'copilot', installed: true, isTerminalAgent: false },
    ]);
    const [, body] = postJson.mock.calls[0] as [string, { agents: Array<Record<string, unknown>> }];
    expect(body.agents[0]).toMatchObject({ id: 'claude', isTerminal: true });
    expect(body.agents[1]).toMatchObject({ id: 'copilot', isTerminal: false });
  });

  it('omits isTerminal when the source has no flag', async () => {
    const postJson = vi
      .spyOn(relay as unknown as { postJson: ReturnType<typeof vi.fn> }, 'postJson')
      .mockResolvedValue({});
    relay.reportAgents([
      { id: 'unknown', name: 'Unknown', icon: 'q', installed: false },
    ]);
    const [, body] = postJson.mock.calls[0] as [string, { agents: Array<Record<string, unknown>> }];
    expect(body.agents[0]).not.toHaveProperty('isTerminal');
  });
});
