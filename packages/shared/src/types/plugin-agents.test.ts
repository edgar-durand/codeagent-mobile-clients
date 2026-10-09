import { describe, expect, it } from 'vitest';
import { isPluginAgentStatus, PLUGIN_AGENT_STATUSES } from './plugin-agents';

describe('PluginAgentStatus (codeagent-04jp)', () => {
  it('names every state the app distinguishes', () => {
    expect([...PLUGIN_AGENT_STATUSES]).toEqual(['ready', 'not_installed', 'not_signed_in', 'failed']);
  });

  it('accepts only known statuses', () => {
    for (const s of PLUGIN_AGENT_STATUSES) expect(isPluginAgentStatus(s)).toBe(true);
    expect(isPluginAgentStatus('online')).toBe(false);
    expect(isPluginAgentStatus(undefined)).toBe(false);
    expect(isPluginAgentStatus(1)).toBe(false);
  });
});
