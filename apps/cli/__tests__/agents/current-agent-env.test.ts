import { afterEach, describe, expect, it } from 'vitest';
import {
  currentAgentEnv,
  resetCurrentAgentEnvForTests,
  setCurrentAgentEnv,
} from '../../src/agents/current-agent-env';
import { spawnAndCapture } from '../../src/services/spawn-and-capture';

/**
 * Headless one-shots (Preview detection, summaries, insights) must run as the
 * agent driving the session NOW, not the one it was deployed with. Before
 * 2026-09-24 they used the frozen deploy-time `process.env`: after a switch to
 * a CodeAgent managed agent, Preview still called the deploy agent's $0
 * OpenRouter key and failed with "Detection Failed" (break-it emulator session).
 */
describe('current agent env for one-shots', () => {
  afterEach(() => resetCurrentAgentEnvForTests());

  it('applies the overlay and unsets undefined keys', () => {
    setCurrentAgentEnv({ ANTHROPIC_BASE_URL: 'https://api.codeagent-mobile.com/api/v1/agent-proxy', OPENROUTER_X: undefined });
    const env = currentAgentEnv({ ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', OPENROUTER_X: '1', KEEP: 'k' });
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.codeagent-mobile.com/api/v1/agent-proxy');
    expect('OPENROUTER_X' in env).toBe(false);
    expect(env.KEEP).toBe('k');
  });

  it('a one-shot spawned after a switch sees the CURRENT agent routing, not the deploy-time one', async () => {
    const prev = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = 'https://openrouter.ai/api'; // frozen at deploy
    try {
      setCurrentAgentEnv({ ANTHROPIC_BASE_URL: 'https://api.codeagent-mobile.com/api/v1/agent-proxy' });
      const out = await spawnAndCapture(process.execPath, ['-e', 'process.stdout.write(process.env.ANTHROPIC_BASE_URL || "")'], {
        timeoutMs: 10_000,
      });
      expect(out?.trim()).toBe('https://api.codeagent-mobile.com/api/v1/agent-proxy');
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = prev;
    }
  });
});
