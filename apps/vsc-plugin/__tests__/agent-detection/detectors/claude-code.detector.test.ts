import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { Extension } from 'vscode';

vi.mock('vscode', () => ({}));

const findClaudeCodeTerminal = vi.fn();
vi.mock('../../../src/services/terminal-agent.service', () => ({
  TerminalAgentService: {
    getInstance: () => ({ findClaudeCodeTerminal }),
  },
}));

import { ClaudeCodeDetector } from '../../../src/services/agent-detection/detectors/claude-code.detector';

function ext(id: string): Extension<unknown> {
  return { id } as unknown as Extension<unknown>;
}
const log = { appendLine: () => undefined } as unknown as Parameters<
  ClaudeCodeDetector['detect']
>[0]['log'];

beforeEach(() => {
  findClaudeCodeTerminal.mockReset();
});

describe('ClaudeCodeDetector', () => {
  test('extension only → installed, no isTerminalAgent', async () => {
    findClaudeCodeTerminal.mockReturnValue(null);
    const detector = new ClaudeCodeDetector();
    const r = await detector.detect({ log, extensions: [ext('anthropic.claude-code')] });
    expect(r).toEqual({
      installed: true,
      extensionId: 'anthropic.claude-code',
      isTerminalAgent: false,
      via: 'extension',
    });
  });

  test('terminal tab only → falls back to canonical extensionId + isTerminalAgent true', async () => {
    findClaudeCodeTerminal.mockReturnValue({});
    const detector = new ClaudeCodeDetector();
    const r = await detector.detect({ log, extensions: [] });
    expect(r).toEqual({
      installed: true,
      extensionId: 'anthropic.claude-code',
      isTerminalAgent: true,
      via: 'terminal-tab',
    });
  });

  test('extension + terminal tab → extension wins for via, isTerminalAgent true', async () => {
    findClaudeCodeTerminal.mockReturnValue({});
    const detector = new ClaudeCodeDetector();
    const r = await detector.detect({ log, extensions: [ext('anthropic.claude-code')] });
    expect(r).toEqual({
      installed: true,
      extensionId: 'anthropic.claude-code',
      isTerminalAgent: true,
      via: 'extension',
    });
  });

  test('neither → null', async () => {
    findClaudeCodeTerminal.mockReturnValue(null);
    const detector = new ClaudeCodeDetector();
    const r = await detector.detect({ log, extensions: [] });
    expect(r).toBeNull();
  });

  test('has id "claude_code" to preserve the legacy __terminal__:claude_code wire id', () => {
    expect(new ClaudeCodeDetector().id).toBe('claude_code');
  });
});
