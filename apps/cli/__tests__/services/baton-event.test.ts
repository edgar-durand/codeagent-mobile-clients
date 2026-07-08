import { describe, it, expect, vi, beforeEach } from 'vitest';
import { postBatonEvent, _transport } from '../../src/services/pairing.service';

describe('postBatonEvent', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('POSTs driver-state to /api/baton/events with the plugin-auth token', async () => {
    const spy = vi.spyOn(_transport, 'postJsonAuthed').mockResolvedValue({});
    const res = await postBatonEvent({
      sessionId: 's1',
      pluginId: 'p1',
      pluginAuthToken: 'tok',
      state: 'MOBILE_DRIVE',
      driver: 'mobile_acp',
      conversationId: 'c1',
    });
    expect(res).toEqual({ ok: true });
    const [url, body, token] = spy.mock.calls[0];
    expect(url).toMatch(/\/api\/baton\/events$/);
    expect(token).toBe('tok');
    expect(body).toMatchObject({
      sessionId: 's1',
      pluginId: 'p1',
      state: 'MOBILE_DRIVE',
      driver: 'mobile_acp',
      conversationId: 'c1',
    });
  });

  it('returns ok:false with status/message when the transport rejects', async () => {
    vi.spyOn(_transport, 'postJsonAuthed').mockRejectedValue(
      Object.assign(new Error('backend unreachable'), { statusCode: 503 }),
    );
    const res = await postBatonEvent({
      sessionId: 's1',
      pluginId: 'p1',
      pluginAuthToken: 'tok',
      state: 'SWITCHING',
      driver: 'local_tui',
      conversationId: null,
    });
    expect(res).toEqual({ ok: false, status: 503, message: 'backend unreachable' });
  });
});
