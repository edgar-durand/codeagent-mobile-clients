import { describe, it, expect } from 'vitest';
import { createRuntimeStrategy, createDeployStrategy } from '../../src/agents/registry';

describe('cli agent registry', () => {
  it('createRuntimeStrategy("claude") returns ClaudeRuntimeStrategy', () => {
    const s = createRuntimeStrategy('claude');
    expect(s.id).toBe('claude');
  });

  it('createDeployStrategy("claude") returns ClaudeDeployStrategy', () => {
    const s = createDeployStrategy('claude');
    expect(s.id).toBe('claude');
  });

  it('throws for disabled agents in Phase 1 (codex)', () => {
    expect(() => createRuntimeStrategy('codex')).toThrow();
    expect(() => createDeployStrategy('codex')).toThrow();
  });

  it('throws for disabled agents (copilot)', () => {
    expect(() => createRuntimeStrategy('copilot')).toThrow();
    expect(() => createDeployStrategy('copilot')).toThrow();
  });
});
