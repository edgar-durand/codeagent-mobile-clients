import { describe, test, expect, vi, beforeEach } from 'vitest';
import type * as vscode from 'vscode';
import { runDetectors, toDetectedAgent } from '../../src/services/agent-detection/registry';
import type { AgentDetector } from '../../src/services/agent-detection/types';

vi.mock('vscode', () => ({}));

function makeLog(): vscode.OutputChannel {
  const stub: Pick<vscode.OutputChannel, 'appendLine' | 'name'> & Partial<vscode.OutputChannel> = {
    name: 'test',
    appendLine: vi.fn(),
  };
  return stub as vscode.OutputChannel;
}

describe('runDetectors', () => {
  let log: vscode.OutputChannel;

  beforeEach(() => {
    log = makeLog();
  });

  test('returns one DetectedAgent per detector that resolves with a result', async () => {
    const detectors: AgentDetector[] = [
      {
        id: 'a',
        name: 'A',
        icon: 'a',
        detect: async () => ({ installed: true, extensionId: 'pub.a', via: 'extension' }),
      },
      {
        id: 'b',
        name: 'B',
        icon: 'b',
        detect: async () => null,
      },
    ];
    const out = await runDetectors(detectors, { log, extensions: [] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'pub.a', name: 'A', extensionId: 'pub.a', installed: true });
  });

  test('synthesises __terminal__:<id> when via is not extension', async () => {
    const detectors: AgentDetector[] = [
      {
        id: 'codex',
        name: 'Codex',
        icon: 'codex',
        detect: async () => ({
          installed: true,
          extensionId: '__binary__:codex',
          isTerminalAgent: true,
          via: 'binary',
        }),
      },
    ];
    const [agent] = await runDetectors(detectors, { log, extensions: [] });
    expect(agent.id).toBe('__terminal__:codex');
    expect(agent.extensionId).toBe('__binary__:codex');
    expect(agent.isTerminalAgent).toBe(true);
  });

  test('isolates detector errors so one throw does not topple the rest', async () => {
    const detectors: AgentDetector[] = [
      {
        id: 'crashy',
        name: 'Crashy',
        icon: 'x',
        detect: async () => {
          throw new Error('boom');
        },
      },
      {
        id: 'ok',
        name: 'Ok',
        icon: 'o',
        detect: async () => ({ installed: true, extensionId: 'pub.ok', via: 'extension' }),
      },
    ];
    const out = await runDetectors(detectors, { log, extensions: [] });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('pub.ok');
    expect(log.appendLine).toHaveBeenCalledWith(expect.stringContaining('crashy'));
  });
});

describe('toDetectedAgent', () => {
  test('returns extensionId as id when via is "extension"', () => {
    const detector: AgentDetector = {
      id: 'claude_code',
      name: 'Claude Code',
      icon: 'claude',
      detect: async () => null,
    };
    const out = toDetectedAgent(detector, {
      installed: true,
      extensionId: 'anthropic.claude-code',
      via: 'extension',
    });
    expect(out.id).toBe('anthropic.claude-code');
    expect(out.extensionId).toBe('anthropic.claude-code');
  });

  test('synthesises __terminal__:<detectorId> when via is not "extension"', () => {
    const detector: AgentDetector = {
      id: 'codex',
      name: 'Codex',
      icon: 'codex',
      detect: async () => null,
    };
    const out = toDetectedAgent(detector, {
      installed: true,
      extensionId: '__binary__:codex',
      isTerminalAgent: true,
      via: 'binary',
    });
    expect(out.id).toBe('__terminal__:codex');
    expect(out.extensionId).toBe('__binary__:codex');
    expect(out.isTerminalAgent).toBe(true);
  });
});
