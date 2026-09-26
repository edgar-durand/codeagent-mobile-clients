import { beforeEach, describe, expect, it, vi } from 'vitest';

const postPreviewEvent = vi.fn(async () => undefined);
vi.mock('../src/services/pairing.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/pairing.service')>()),
  postPreviewEvent: (...a: unknown[]) => postPreviewEvent(...(a as [])),
}));

// QA 2026-09-26: after a codespace stop the app showed the dead Expo preview as
// "RUNNING FOR 35 MIN". The first heartbeat of a fresh CLI clears it — unless
// this process was already asked for a preview (never cut a bring-up short).
describe('makePreviewReaffirm — stale preview after a restart', () => {
  beforeEach(() => {
    vi.resetModules();
    postPreviewEvent.mockClear();
  });

  async function load() {
    return import('../src/commands/start/handlers');
  }

  it('publishes preview_stopped on the first beat of a fresh process', async () => {
    const mod = await load();
    const rider = mod.makePreviewReaffirm({ sessionId: 's1', pluginId: 'p1', pluginAuthToken: 't' });
    rider?.({ firstAfterConnect: true });
    await vi.waitFor(() => expect(postPreviewEvent).toHaveBeenCalledTimes(1));
    expect(postPreviewEvent).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', type: 'preview_stopped', payload: { reason: 'restart' } }),
    );
  });

  it('stays silent once this process was asked for a preview', async () => {
    const mod = await load();
    await mod.handlers.request_preview_detect?.({} as never, {} as never, {} as never);
    const rider = mod.makePreviewReaffirm({ sessionId: 's1', pluginId: 'p1', pluginAuthToken: 't' });
    rider?.({ firstAfterConnect: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(postPreviewEvent).not.toHaveBeenCalled();
  });
});
