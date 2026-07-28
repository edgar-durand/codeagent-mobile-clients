import { describe, it, expect, vi } from 'vitest';
import { startClaudeCredentialSync } from '../../../src/agents/claude/credential-sync';

function makeDeps(credential: string | null) {
  const push = vi.fn().mockResolvedValue(undefined);
  const read = vi.fn().mockResolvedValue(
    credential === null ? null : { method: 'oauth', credential, agentState: '{"x":1}' },
  );
  return { push, read };
}

describe('startClaudeCredentialSync', () => {
  it('pushes the fresh credential to the vault under the public claude_code id', async () => {
    const { push, read } = makeDeps('{"claudeAiOauth":{"accessToken":"fresh"}}');
    const h = startClaudeCredentialSync({
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      pluginAuthToken: 'tok',
      push,
      read,
    });
    await h.syncNow();

    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'claude_code',
        sessionId: 'sess-1',
        pluginId: 'plug-1',
        method: 'oauth',
        credential: '{"claudeAiOauth":{"accessToken":"fresh"}}',
        agentState: '{"x":1}',
      }),
    );
    await h.stop();
  });

  it('skips a redundant push when the credential is unchanged (content-hashed)', async () => {
    const { push, read } = makeDeps('{"claudeAiOauth":{"accessToken":"same"}}');
    const h = startClaudeCredentialSync({
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      pluginAuthToken: 'tok',
      push,
      read,
    });
    await h.syncNow();
    await h.syncNow(); // same bytes → no second POST
    expect(push).toHaveBeenCalledTimes(1);
    await h.stop();
  });

  it('does nothing when there is no local credential', async () => {
    const { push, read } = makeDeps(null);
    const h = startClaudeCredentialSync({
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      pluginAuthToken: 'tok',
      push,
      read,
    });
    await h.syncNow();
    expect(push).not.toHaveBeenCalled();
    await h.stop();
  });
});
