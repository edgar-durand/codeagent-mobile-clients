import { describe, it, expect } from 'vitest';
import { HANDOFF_FENCE_TAG, SQUAD_SPECIALTIES } from '../src/types/agent-squad';
import { USER_EVENTS } from '../src/types/events';

describe('agent-squad shared surface', () => {
  it('registers the handoff event names', () => {
    expect(USER_EVENTS.HANDOFF_PROPOSED).toBe('handoff_proposed');
    expect(USER_EVENTS.HANDOFF_RESOLVED).toBe('handoff_resolved');
  });
  it('fence tag is stable wire surface', () => {
    expect(HANDOFF_FENCE_TAG).toBe('codeam-handoff');
  });
  it('every specialty maps a known runtime id', () => {
    for (const key of Object.keys(SQUAD_SPECIALTIES)) {
      expect(['claude', 'codex', 'cursor', 'gemini', 'kimi', 'opencode']).toContain(key);
    }
  });
});
