import { describe, it, expect } from 'vitest';
import type { AgentId, AgentAuth, AgentAuthKind, AgentMetadata, NormalizedMessage } from '../src/agents/types';

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
