import { describe, it, expect, vi, afterEach } from 'vitest';
import { _transport } from '../../src/services/file-watcher/transport';
import { inheritTeamMemories } from '../../src/beads/inherit-team-memories';
import type { BdAdapter } from '../../src/beads/bd-adapter';

function fakeAdapter() {
  return { run: vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' }) } as unknown as BdAdapter & { run: ReturnType<typeof vi.fn> };
}
const base = { sessionId: 's1', pluginId: 'p1', pluginAuthToken: 'tok', apiBaseUrl: 'https://api.test' };
const resp = (statusCode: number, data: unknown) => ({ statusCode, body: JSON.stringify({ success: true, data }) });

describe('inheritTeamMemories', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes each team memory into the active repo via `bd remember --key team-<id>` (idempotent)', async () => {
    vi.spyOn(_transport, 'post').mockResolvedValue(
      resp(200, { memories: [{ id: 'm1', body: 'Always squash-merge' }, { id: 'm2', body: 'Prefix branches with ticket id' }] }),
    );
    const adapter = fakeAdapter();
    await inheritTeamMemories({ ...base, adapter });
    expect(adapter.run).toHaveBeenCalledTimes(2);
    expect(adapter.run).toHaveBeenCalledWith(['remember', '--key', 'team-m1', 'Team convention (read-only): Always squash-merge']);
    expect(adapter.run).toHaveBeenCalledWith(['remember', '--key', 'team-m2', 'Team convention (read-only): Prefix branches with ticket id']);
  });

  it('hits the plugin-auth endpoint with sessionId/pluginId + the auth-token header', async () => {
    const post = vi.spyOn(_transport, 'post').mockResolvedValue(resp(200, { memories: [] }));
    await inheritTeamMemories({ ...base, adapter: fakeAdapter() });
    expect(post).toHaveBeenCalledTimes(1);
    const [url, headers, body] = post.mock.calls[0];
    expect(url).toBe('https://api.test/api/beads/team-memories');
    expect((headers as Record<string, string>)['X-Plugin-Auth-Token']).toBe('tok');
    expect(JSON.parse(body as string)).toEqual({ sessionId: 's1', pluginId: 'p1' });
  });

  it('no team memories → writes nothing', async () => {
    vi.spyOn(_transport, 'post').mockResolvedValue(resp(200, { memories: [] }));
    const adapter = fakeAdapter();
    await inheritTeamMemories({ ...base, adapter });
    expect(adapter.run).not.toHaveBeenCalled();
  });

  it('non-2xx response → non-fatal, writes nothing', async () => {
    vi.spyOn(_transport, 'post').mockResolvedValue({ statusCode: 403, body: 'forbidden' });
    const adapter = fakeAdapter();
    await expect(inheritTeamMemories({ ...base, adapter })).resolves.toBeUndefined();
    expect(adapter.run).not.toHaveBeenCalled();
  });

  it('skips empty-body entries; a single bd failure does not abort the rest', async () => {
    vi.spyOn(_transport, 'post').mockResolvedValue(
      resp(200, { memories: [{ id: 'm1', body: '   ' }, { id: 'm2', body: 'real one' }] }),
    );
    const adapter = fakeAdapter();
    (adapter.run as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('bd boom'));
    await inheritTeamMemories({ ...base, adapter });
    // m1 skipped (empty); m2 attempted (even though the first run rejected).
    expect(adapter.run).toHaveBeenCalledWith(['remember', '--key', 'team-m2', 'Team convention (read-only): real one']);
  });

  it('transport throwing is non-fatal', async () => {
    vi.spyOn(_transport, 'post').mockRejectedValue(new Error('network down'));
    const adapter = fakeAdapter();
    await expect(inheritTeamMemories({ ...base, adapter })).resolves.toBeUndefined();
    expect(adapter.run).not.toHaveBeenCalled();
  });
});
