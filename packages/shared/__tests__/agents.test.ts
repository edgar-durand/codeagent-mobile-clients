import { describe, it, expect } from 'vitest';
import type { AgentId, AgentAuth, NormalizedMessage } from '../src/agents/types';
import { AGENT_REGISTRY, getEnabledAgents, getAgent } from '../src/agents/registry';

describe('agent types', () => {
  it('AgentId accepts the three known agents', () => {
    const ids: AgentId[] = ['claude', 'codex', 'copilot'];
    expect(ids.length).toBe(3);
  });

  it('AgentAuth structurally matches kind+value', () => {
    const a: AgentAuth = { kind: 'api_key', value: 'sk-test' };
    expect(a.kind).toBe('api_key');
    expect(a.value).toBe('sk-test');
  });

  it('NormalizedMessage has required fields', () => {
    const m: NormalizedMessage = {
      id: 'm1',
      role: 'user',
      text: 'hi',
      timestamp: '2026-05-13T00:00:00Z',
    };
    expect(m.id).toBe('m1');
  });
});

describe('AGENT_REGISTRY', () => {
  it('has entries for claude, codex, copilot', () => {
    expect(AGENT_REGISTRY.claude).toBeDefined();
    expect(AGENT_REGISTRY.codex).toBeDefined();
    expect(AGENT_REGISTRY.copilot).toBeDefined();
  });

  it('claude is enabled in Phase 1', () => {
    expect(AGENT_REGISTRY.claude.enabled).toBe(true);
  });

  it('all terminal agents are enabled; copilot still disabled (no runtime builder)', () => {
    expect(AGENT_REGISTRY.claude.enabled).toBe(true);
    expect(AGENT_REGISTRY.codex.enabled).toBe(true);
    expect(AGENT_REGISTRY.cursor.enabled).toBe(true);
    expect(AGENT_REGISTRY.coderabbit.enabled).toBe(true);
    expect(AGENT_REGISTRY.aider.enabled).toBe(true);
    expect(AGENT_REGISTRY.copilot.enabled).toBe(false);
  });

  it('getEnabledAgents returns only enabled ones', () => {
    const enabled = getEnabledAgents();
    expect(enabled.map(a => a.id).sort()).toEqual(['aider', 'claude', 'coderabbit', 'codex', 'cursor']);
  });

  it('getAgent throws on unknown id', () => {
    expect(() => getAgent('zzz' as any)).toThrow();
  });

  it('every agent declares its preferredAuthKind in supportedAuthKinds', () => {
    for (const meta of Object.values(AGENT_REGISTRY)) {
      expect(meta.supportedAuthKinds).toContain(meta.preferredAuthKind);
    }
  });
});
