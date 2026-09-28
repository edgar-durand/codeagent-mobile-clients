import { describe, it, expect, vi } from 'vitest';
import { registerScratchProject, postScratchOffer } from '../../src/scratch/api';

describe('scratch api', () => {
  it('register POSTs /api/scratch/projects/register with the plugin token header', async () => {
    const ctx = { sessionId: 's1', pluginId: 'p1', pluginAuthToken: 'tok' };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ success: true }),
    });
    await registerScratchProject(ctx, 'dep1', fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string | URL, RequestInit];
    expect(String(url)).toMatch(/\/api\/scratch\/projects\/register$/);
    expect(init.headers).toMatchObject({ 'X-Plugin-Auth-Token': 'tok' });
    expect(JSON.parse(init.body as string)).toEqual({
      sessionId: 's1',
      pluginId: 'p1',
      deployId: 'dep1',
    });
  });

  it('never throws on a network error', async () => {
    const ctx = { sessionId: 's', pluginId: 'p', pluginAuthToken: 'tok' };
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    await expect(postScratchOffer(ctx, fetchImpl as unknown as typeof fetch)).resolves.toBe(false);
  });

  it('skips without a plugin token', async () => {
    const ctx = { sessionId: 's', pluginId: 'p' };
    const fetchImpl = vi.fn();
    await expect(postScratchOffer(ctx, fetchImpl as unknown as typeof fetch)).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
