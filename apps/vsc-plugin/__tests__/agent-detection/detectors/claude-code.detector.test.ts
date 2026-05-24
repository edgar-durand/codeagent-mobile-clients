import { describe, test, expect } from 'vitest';
import type { Extension } from 'vscode';

import { ClaudeCodeDetector } from '../../../src/services/agent-detection/detectors/claude-code.detector';

function ext(id: string): Extension<unknown> {
  return { id } as unknown as Extension<unknown>;
}
const log = { appendLine: () => undefined } as unknown as Parameters<
  ClaudeCodeDetector['detect']
>[0]['log'];

describe('ClaudeCodeDetector', () => {
  test('extension present → reports installed terminal agent (CLI runs Claude)', async () => {
    const detector = new ClaudeCodeDetector();
    const r = await detector.detect({ log, extensions: [ext('anthropic.claude-code')] });
    expect(r).toEqual({
      installed: true,
      extensionId: 'anthropic.claude-code',
      isTerminalAgent: true,
      via: 'extension',
    });
  });

  test('alternate extension id is also accepted', async () => {
    const detector = new ClaudeCodeDetector();
    const r = await detector.detect({ log, extensions: [ext('anthropics.claude')] });
    expect(r?.extensionId).toBe('anthropics.claude');
    expect(r?.isTerminalAgent).toBe(true);
  });

  test('no Anthropic extension → null', async () => {
    const detector = new ClaudeCodeDetector();
    const r = await detector.detect({ log, extensions: [] });
    expect(r).toBeNull();
  });

  test('has id "claude_code" to preserve the __terminal__:claude_code wire id', () => {
    expect(new ClaudeCodeDetector().id).toBe('claude_code');
  });
});
