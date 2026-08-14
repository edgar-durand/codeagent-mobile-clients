/**
 * fleet-1 2026-08-13, codeam-cli 2.65.0: alongside the squad-context leak,
 * codex's own injected `<recommended_plugins>` config block reached the web
 * dashboard as a bubble attributed to the user. `isAgentMetaBlock` is the
 * exact-anchor, whole-message classifier that keeps agent-injected meta/config
 * blocks out of hydrated transcripts.
 */
import { describe, it, expect } from 'vitest';
import { isAgentMetaBlock } from '../../../src/agents/acp/agent-meta-blocks';

describe('isAgentMetaBlock', () => {
  it('flags a whole-message <recommended_plugins> config block', () => {
    const block = [
      '<recommended_plugins>',
      '  - openai/curated-remote-plugin-a',
      '  - openai/curated-remote-plugin-b',
      '</recommended_plugins>',
    ].join('\n');
    expect(isAgentMetaBlock(block)).toBe(true);
  });

  it('flags it with leading/trailing whitespace from the transport', () => {
    expect(isAgentMetaBlock('\n\n<recommended_plugins>\n…\n</recommended_plugins>\n\n')).toBe(true);
  });

  it('leaves ordinary user text alone', () => {
    expect(isAgentMetaBlock('fix the parser')).toBe(false);
  });

  it('does NOT strip a user message that merely MENTIONS recommended_plugins mid-sentence', () => {
    const userText = 'can you check the recommended_plugins list in our config?';
    expect(isAgentMetaBlock(userText)).toBe(false);
  });

  it('does NOT strip when the tag appears mid-message, not as the whole-message anchor', () => {
    const text =
      'here is context:\n<recommended_plugins>\nfoo\n</recommended_plugins>\nnow help me';
    expect(isAgentMetaBlock(text)).toBe(false);
  });
});
