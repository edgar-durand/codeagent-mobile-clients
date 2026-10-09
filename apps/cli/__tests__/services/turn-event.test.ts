import { describe, it, expect, vi, beforeEach } from 'vitest';
import { postTurnEvent, _transport } from '../../src/services/pairing.service';

// codeagent-wj4n: /api/commands/turn-events is behind PluginAuthGuard, which
// reads sessionId AND pluginId from the body to verify the HMAC. Without
// sessionId every report was a 401 PLUGIN_TOKEN_REQUIRED.
describe('postTurnEvent', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('POSTs sessionId + pluginId with the plugin-auth token', async () => {
    const spy = vi.spyOn(_transport, 'postJsonAuthed').mockResolvedValue({});
    await postTurnEvent({
      sessionId: 's1',
      pluginId: 'p1',
      pluginAuthToken: 'tok',
      commandId: 'cmd-1',
      phase: 'started',
      agentId: 'claude',
    });
    const [url, body, token] = spy.mock.calls[0];
    expect(url).toMatch(/\/api\/commands\/turn-events$/);
    expect(token).toBe('tok');
    expect(body).toMatchObject({
      sessionId: 's1',
      pluginId: 'p1',
      commandId: 'cmd-1',
      phase: 'started',
      agentId: 'claude',
    });
  });

  it('never throws when the transport rejects (fire-and-forget)', async () => {
    vi.spyOn(_transport, 'postJsonAuthed').mockRejectedValue(
      Object.assign(new Error('Unauthorized'), { statusCode: 401 }),
    );
    await expect(
      postTurnEvent({
        sessionId: 's1',
        pluginId: 'p1',
        pluginAuthToken: 'tok',
        commandId: 'cmd-1',
        phase: 'failed',
        errorCode: 'EMPTY_PROMPT',
      }),
    ).resolves.toBeUndefined();
  });
});
