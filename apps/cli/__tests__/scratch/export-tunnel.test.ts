import { EventEmitter } from 'node:events';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/preview/named-tunnel', () => ({
  resolveNamedTunnel: vi.fn(),
}));
vi.mock('../../src/services/preview/cloudflared', () => ({
  resolveCloudflared: vi.fn(async () => '/fake/cloudflared'),
  spawnNamedTunnel: vi.fn(),
}));
vi.mock('../../src/services/preview/tunnel-bringup', () => ({
  awaitTunnelRegistered: vi.fn(),
}));
vi.mock('../../src/services/pairing.service', () => ({
  fetchNamedPreviewTunnel: vi.fn(),
}));

import { resolveNamedTunnel } from '../../src/services/preview/named-tunnel';
import { spawnNamedTunnel } from '../../src/services/preview/cloudflared';
import { awaitTunnelRegistered } from '../../src/services/preview/tunnel-bringup';
import { activePreviews, type ActivePreview } from '../../src/services/preview/index';
import { ensureExportBaseUrl, stopExportTunnel } from '../../src/scratch/export-tunnel';

const ctx = { sessionId: 's-1', pluginId: 'p-1', pluginAuthToken: 'tok' };

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn>; exitCode: null };
  child.kill = vi.fn();
  child.exitCode = null;
  return child;
}

beforeEach(() => {
  vi.mocked(resolveNamedTunnel).mockReset();
  vi.mocked(spawnNamedTunnel).mockReset();
  vi.mocked(awaitTunnelRegistered).mockReset();
});

afterEach(async () => {
  activePreviews.clear();
  await stopExportTunnel();
});

describe('ensureExportBaseUrl', () => {
  it('reuses a running preview tunnel + inspector proxy and spawns nothing', async () => {
    activePreviews.set(ctx.sessionId, {
      tunnel: fakeChild(),
      inspector: { close: async () => {} },
      url: 'https://preview-x.codeagent-mobile.com/',
    } as unknown as ActivePreview);
    const { baseUrl, release } = await ensureExportBaseUrl(ctx);
    expect(baseUrl).toBe('https://preview-x.codeagent-mobile.com');
    expect(resolveNamedTunnel).not.toHaveBeenCalled();
    expect(spawnNamedTunnel).not.toHaveBeenCalled();
    expect(() => release()).not.toThrow();
  });

  it('with no preview, starts a standalone server behind the named tunnel', async () => {
    const child = fakeChild();
    vi.mocked(resolveNamedTunnel).mockResolvedValue({ token: 'T', hostname: 'box-1.preview.codeagent-mobile.com' });
    vi.mocked(spawnNamedTunnel).mockResolvedValue(child as never);
    vi.mocked(awaitTunnelRegistered).mockResolvedValue({
      kind: 'registered',
      url: 'https://box-1.preview.codeagent-mobile.com',
    });
    const { baseUrl } = await ensureExportBaseUrl(ctx);
    expect(baseUrl).toBe('https://box-1.preview.codeagent-mobile.com');
    expect(resolveNamedTunnel).toHaveBeenCalledTimes(1);
    const [bin, token, port] = vi.mocked(spawnNamedTunnel).mock.calls[0];
    expect(bin).toBe('/fake/cloudflared');
    expect(token).toBe('T');
    expect(port).toBeGreaterThan(0);
    // The loopback server answers unknown paths with 404.
    const status = await new Promise<number>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/nope', agent: false }, (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        })
        .on('error', reject);
    });
    expect(status).toBe(404);
  });

  it('a preview holding a tunnel WITHOUT the inspector proxy blocks a second connector', async () => {
    activePreviews.set(ctx.sessionId, {
      tunnel: fakeChild(),
      inspector: null,
      url: 'https://preview-x.codeagent-mobile.com',
    } as unknown as ActivePreview);
    vi.mocked(resolveNamedTunnel).mockResolvedValue({ token: 'T', hostname: 'h.example' });
    await expect(ensureExportBaseUrl(ctx)).rejects.toThrow('EXPORT_TUNNEL_UNAVAILABLE');
    expect(spawnNamedTunnel).not.toHaveBeenCalled();
    expect(resolveNamedTunnel).not.toHaveBeenCalled();
  });

  it("another session's inspector-less preview tunnel also blocks a second connector", async () => {
    activePreviews.set('other-session', {
      tunnel: fakeChild(),
      inspector: null,
      url: 'https://preview-y.codeagent-mobile.com',
    } as unknown as ActivePreview);
    vi.mocked(resolveNamedTunnel).mockResolvedValue({ token: 'T', hostname: 'h.example' });
    await expect(ensureExportBaseUrl(ctx)).rejects.toThrow('EXPORT_TUNNEL_UNAVAILABLE');
    expect(spawnNamedTunnel).not.toHaveBeenCalled();
  });

  it('rejects EXPORT_TUNNEL_UNAVAILABLE when no named tunnel can be resolved', async () => {
    vi.mocked(resolveNamedTunnel).mockResolvedValue(null);
    await expect(ensureExportBaseUrl(ctx)).rejects.toThrow('EXPORT_TUNNEL_UNAVAILABLE');
    expect(spawnNamedTunnel).not.toHaveBeenCalled();
  });

  it('rejects EXPORT_TUNNEL_UNAVAILABLE and cleans up when the tunnel never registers', async () => {
    const child = fakeChild();
    vi.mocked(resolveNamedTunnel).mockResolvedValue({ token: 'T', hostname: 'h.example' });
    vi.mocked(spawnNamedTunnel).mockResolvedValue(child as never);
    vi.mocked(awaitTunnelRegistered).mockResolvedValue({ kind: 'timeout', sawUrl: true });
    await expect(ensureExportBaseUrl(ctx)).rejects.toThrow('EXPORT_TUNNEL_UNAVAILABLE');
    expect(child.kill).toHaveBeenCalled();
    const port = vi.mocked(spawnNamedTunnel).mock.calls[0][2];
    await expect(
      new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, agent: false }, resolve).on('error', reject)),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('release() of a standalone tunnel kills the cloudflared child and closes the server', async () => {
    const child = fakeChild();
    vi.mocked(resolveNamedTunnel).mockResolvedValue({ token: 'T', hostname: 'h.example' });
    vi.mocked(spawnNamedTunnel).mockResolvedValue(child as never);
    vi.mocked(awaitTunnelRegistered).mockResolvedValue({ kind: 'registered', url: 'https://h.example' });
    const { release } = await ensureExportBaseUrl(ctx);
    const port = vi.mocked(spawnNamedTunnel).mock.calls[0][2];
    release();
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGTERM'));
    await vi.waitFor(async () => {
      await expect(
        new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, agent: false }, resolve).on('error', reject)),
      ).rejects.toThrow(/ECONNREFUSED/);
    });
  });

  it('stopExportTunnel stops a running standalone tunnel (a new preview needs the named tunnel)', async () => {
    const child = fakeChild();
    vi.mocked(resolveNamedTunnel).mockResolvedValue({ token: 'T', hostname: 'h.example' });
    vi.mocked(spawnNamedTunnel).mockResolvedValue(child as never);
    vi.mocked(awaitTunnelRegistered).mockResolvedValue({ kind: 'registered', url: 'https://h.example' });
    await ensureExportBaseUrl(ctx);
    await stopExportTunnel();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await expect(stopExportTunnel()).resolves.toBeUndefined();
  });

  it('two concurrent calls share one setup: one spawn, same base URL', async () => {
    const child = fakeChild();
    let register!: () => void;
    vi.mocked(resolveNamedTunnel).mockResolvedValue({ token: 'T', hostname: 'h.example' });
    vi.mocked(spawnNamedTunnel).mockResolvedValue(child as never);
    vi.mocked(awaitTunnelRegistered).mockImplementation(
      () => new Promise((r) => (register = () => r({ kind: 'registered', url: 'https://h.example' }))),
    );
    const a = ensureExportBaseUrl(ctx);
    const b = ensureExportBaseUrl(ctx);
    await vi.waitFor(() => expect(awaitTunnelRegistered).toHaveBeenCalled());
    register();
    const [ra, rb] = await Promise.all([a, b]);
    expect(spawnNamedTunnel).toHaveBeenCalledTimes(1);
    expect(ra.baseUrl).toBe('https://h.example');
    expect(rb.baseUrl).toBe('https://h.example');
    // Shared: the connector survives until the LAST handle is released.
    ra.release();
    expect(child.kill).not.toHaveBeenCalled();
    rb.release();
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGTERM'));
  });

  it('stop during a pending setup kills the late connector; later calls start fresh', async () => {
    const child1 = fakeChild();
    const child2 = fakeChild();
    let register!: () => void;
    vi.mocked(resolveNamedTunnel).mockResolvedValue({ token: 'T', hostname: 'h.example' });
    vi.mocked(spawnNamedTunnel).mockResolvedValueOnce(child1 as never).mockResolvedValueOnce(child2 as never);
    vi.mocked(awaitTunnelRegistered)
      .mockImplementationOnce(
        () => new Promise((r) => (register = () => r({ kind: 'registered', url: 'https://h.example' }))),
      )
      .mockResolvedValueOnce({ kind: 'registered', url: 'https://h.example' });

    const first = ensureExportBaseUrl(ctx);
    await vi.waitFor(() => expect(awaitTunnelRegistered).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stop = stopExportTunnel().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false); // stop waits for the in-flight setup
    register();
    await stop;
    expect(child1.kill).toHaveBeenCalledWith('SIGTERM');
    await expect(first).rejects.toThrow('EXPORT_TUNNEL_UNAVAILABLE');

    const second = await ensureExportBaseUrl(ctx);
    expect(spawnNamedTunnel).toHaveBeenCalledTimes(2);
    expect(second.baseUrl).toBe('https://h.example');
    expect(child2.kill).not.toHaveBeenCalled();
  });

  it('a stale release from a stopped S1 does not tear down a new S2, and release is idempotent', async () => {
    const child1 = fakeChild();
    const child2 = fakeChild();
    vi.mocked(resolveNamedTunnel).mockResolvedValue({ token: 'T', hostname: 'h.example' });
    vi.mocked(spawnNamedTunnel).mockResolvedValueOnce(child1 as never).mockResolvedValueOnce(child2 as never);
    vi.mocked(awaitTunnelRegistered).mockResolvedValue({ kind: 'registered', url: 'https://h.example' });

    const s1 = await ensureExportBaseUrl(ctx);
    await stopExportTunnel();
    expect(child1.kill).toHaveBeenCalledTimes(1);

    const s2a = await ensureExportBaseUrl(ctx);
    const s2b = await ensureExportBaseUrl(ctx);
    expect(spawnNamedTunnel).toHaveBeenCalledTimes(2);

    s1.release();
    s1.release();
    // Double release of ONE handle must not drop the other handle's hold.
    s2a.release();
    s2a.release();
    await new Promise((r) => setTimeout(r, 20));
    expect(child2.kill).not.toHaveBeenCalled();
    expect(child1.kill).toHaveBeenCalledTimes(1);

    s2b.release();
    await vi.waitFor(() => expect(child2.kill).toHaveBeenCalledWith('SIGTERM'));
  });
});
