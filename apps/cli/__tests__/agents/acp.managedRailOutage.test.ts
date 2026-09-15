/**
 * A managed/house session runs the Claude Code RUNTIME against OUR agent-proxy,
 * so its runtime agent id collapses to `claude` for EVERY managed provider.
 * The vendor lookup keyed on that id therefore named **Anthropic** when our own
 * proxy (DeepInfra / MiniMax) returned an overload — and linked
 * status.anthropic.com, which is green because Anthropic was never involved.
 *
 * Live report (rafaelph90.br@gmail.com, 2026-09-15): working on `managed-qwen-coder`,
 * got "Anthropic is having a service disruption", checked the status page, found
 * "All Systems Operational", and lost trust in the diagnosis.
 */
import { describe, expect, it } from 'vitest';
import {
  agentStatusPage,
  providerOutageMessage,
  failureBubble,
  adapterExitMessage,
} from '../../src/agents/acp/failure-messages';

const OVERLOAD = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}';

describe('managed rail never blames an upstream vendor for our proxy', () => {
  it.each([
    ['managed-qwen-coder', 'Qwen3 Coder'],
    ['managed-deepseek', 'DeepSeek V4'],
    ['managed-deepseek-flash', 'DeepSeek V4 Flash'],
    ['managed-codex', 'Codex'],
    ['managed-claude', 'Claude'],
    ['house-codeagent-cloud', 'CodeAgent Cloud'],
  ])('%s: no Anthropic, no vendor status link, names the agent', (railWireId: string, display: string) => {
    // The runtime id is ALWAYS `claude` on this rail — that is the whole trap.
    const msg = providerOutageMessage('claude', railWireId);
    expect(msg).not.toMatch(/Anthropic/i);
    expect(msg).not.toMatch(/status\.anthropic\.com/);
    expect(msg).not.toMatch(/status\.openai\.com/);
    expect(msg).toContain(display);
    expect(msg).toMatch(/CodeAgent/);
    expect(agentStatusPage('claude', railWireId)).toBeNull();
  });

  it('routes the managed message through failureBubble on a real overload', () => {
    const bubble = failureBubble({
      detail: OVERLOAD,
      recentStderr: '',
      hadText: false,
      agent: 'claude',
      railWireId: 'managed-qwen-coder',
    });
    expect(bubble).toBe(providerOutageMessage('claude', 'managed-qwen-coder'));
    expect(bubble).not.toMatch(/Anthropic/i);
  });

  it('routes the managed message through an adapter crash on a real overload', () => {
    const msg = adapterExitMessage({
      code: 1,
      signal: null,
      authFail: false,
      outageFail: true,
      agent: 'claude',
      railWireId: 'managed-deepseek',
    });
    expect(msg).toBe(providerOutageMessage('claude', 'managed-deepseek'));
    expect(msg).not.toMatch(/Anthropic/i);
  });

  it('BYO agents are untouched — a real Anthropic outage still names Anthropic', () => {
    const msg = providerOutageMessage('claude', null);
    expect(msg).toContain('Anthropic');
    expect(msg).toContain('https://status.anthropic.com');
    expect(agentStatusPage('claude', null)?.vendor).toBe('Anthropic');
    expect(providerOutageMessage('codex', null)).toContain('OpenAI');
    expect(providerOutageMessage('gemini')).toContain('Google');
  });
});
