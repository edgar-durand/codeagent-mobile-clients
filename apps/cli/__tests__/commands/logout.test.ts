import { describe, it, expect, vi } from 'vitest';

// codeagent-x5t: the backend refuses a heartbeat without the poll secret for a
// plugin that has proven it, so logout's goodbye beat must carry the secret
// of each session it knows — or the app keeps showing the session online.

const { postJsonMock } = vi.hoisted(() => ({ postJsonMock: vi.fn() }));

vi.mock('../../src/config', () => ({
  loadCliConfig: vi.fn(() => ({
    pluginId: 'global-plugin',
    activeSessionId: 's1',
    sessions: [
      { id: 's1', pluginId: 'plugin-with-secret', pollSecret: 'secret-1' },
      { id: 's2', pluginId: 'legacy-plugin' },
    ],
  })),
  clearAll: vi.fn(),
}));
vi.mock('../../src/ui/banner', () => ({ showIntro: vi.fn() }));
vi.mock('../../src/ui/prompts', () => ({ confirmAction: vi.fn(async () => true) }));
vi.mock('../../src/services/pairing.service', () => ({ _postJson: postJsonMock }));

import { logout } from '../../src/commands/logout';

describe('logout → offline heartbeats', () => {
  it('sends each known poll secret, and none for a plugin without one', async () => {
    postJsonMock.mockResolvedValue({ success: true });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await logout();

    const byPlugin = new Map(
      postJsonMock.mock.calls.map(([, body, headers]) => [
        (body as { pluginId: string }).pluginId,
        headers as Record<string, string>,
      ]),
    );
    expect(byPlugin.get('plugin-with-secret')).toEqual({ 'X-Plugin-Poll-Secret': 'secret-1' });
    expect(byPlugin.get('legacy-plugin')).toEqual({});
    expect(byPlugin.get('global-plugin')).toEqual({});
    for (const [url, body] of postJsonMock.mock.calls) {
      expect(String(url)).toContain('/api/plugin/heartbeat');
      expect(body).toMatchObject({ online: false });
    }
  });
});
