import { describe, expect, test } from 'vitest';
import { normalizeCliAgentId } from '../src/utils/cli-agent-id';

describe('normalizeCliAgentId', () => {
  test('keeps known CLI agent ids', () => {
    expect(normalizeCliAgentId('claude')).toBe('claude');
    expect(normalizeCliAgentId('codex')).toBe('codex');
    expect(normalizeCliAgentId('cursor')).toBe('cursor');
  });

  test('maps terminal wire ids to CLI agent ids', () => {
    expect(normalizeCliAgentId('__terminal__:claude_code')).toBe('claude');
    expect(normalizeCliAgentId('__terminal__:codex')).toBe('codex');
    expect(normalizeCliAgentId('__terminal__:coderabbit')).toBe('coderabbit');
  });

  test('maps extension aliases used by mobile payloads', () => {
    expect(normalizeCliAgentId('Anthropic.claude-ce')).toBe('claude');
    expect(normalizeCliAgentId('anthropic.claude-code')).toBe('claude');
    expect(normalizeCliAgentId('openai.chatgpt')).toBe('codex');
  });

  test('rejects unknown ids instead of shell-splicing them', () => {
    expect(normalizeCliAgentId('unknown; rm -rf /')).toBeNull();
    expect(normalizeCliAgentId('copilot')).toBeNull();
    expect(normalizeCliAgentId(null)).toBeNull();
  });
});
