import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveNamedTunnel } from '../../src/services/preview/named-tunnel';

/**
 * Where a named tunnel comes from on a box the backend never provisioned one for.
 *
 * WHY THIS EXISTS — codeagent-xsot. `ensureTunnel` was reachable only from the
 * codespace provisioning path, which exports `PREVIEW_TUNNEL_TOKEN` /
 * `PREVIEW_TUNNEL_HOSTNAME` into the environment. A CodeAgent Box, a
 * self-hosted host and the SHARED DEMO SESSION got neither (verified on the
 * demo box: both empty in the live process env), so every preview they served
 * rode a `*.trycloudflare.com` quick tunnel — the hostname whose DNS
 * propagation window left the web preview panel blank in replay 01a03418.
 *
 * The backend now mints one ON DEMAND (`POST /api/preview/tunnel`), so the CLI
 * asks for it when the environment did not already hand it one. Asking at
 * PREVIEW START rather than at deploy is deliberate: each named tunnel costs a
 * DNS record against Cloudflare Free's 200-record cap, which is exactly what
 * filled up in 2026-08 and dropped everyone to quick tunnels anyway.
 */
describe('resolveNamedTunnel', () => {
  const ctx = { sessionId: 'sess-1', pluginId: 'plug-1', pluginAuthToken: 'tok' };

  beforeEach(() => {
    delete process.env.PREVIEW_TUNNEL_TOKEN;
    delete process.env.PREVIEW_TUNNEL_HOSTNAME;
  });
  afterEach(() => {
    delete process.env.PREVIEW_TUNNEL_TOKEN;
    delete process.env.PREVIEW_TUNNEL_HOSTNAME;
  });

  it('prefers the environment, without calling the backend', async () => {
    process.env.PREVIEW_TUNNEL_TOKEN = 'env-token';
    process.env.PREVIEW_TUNNEL_HOSTNAME = 'preview-env.codeagent-mobile.com';
    const fetchTunnel = vi.fn();

    await expect(resolveNamedTunnel(ctx, fetchTunnel)).resolves.toEqual({
      token: 'env-token',
      hostname: 'preview-env.codeagent-mobile.com',
    });
    // The codespace bootstrap already exported it; a round-trip here would be
    // pure latency on the preview's critical path.
    expect(fetchTunnel).not.toHaveBeenCalled();
  });

  it('asks the backend when the environment has none', async () => {
    const fetchTunnel = vi.fn().mockResolvedValue({
      hostname: 'preview-abc.codeagent-mobile.com',
      token: 'minted',
    });

    await expect(resolveNamedTunnel(ctx, fetchTunnel)).resolves.toEqual({
      token: 'minted',
      hostname: 'preview-abc.codeagent-mobile.com',
    });
    expect(fetchTunnel).toHaveBeenCalledWith(ctx);
  });

  // Every one of these means "no named tunnel" — and that is a perfectly good
  // answer, because the caller's quick tunnel still works. None of them may
  // fail the preview.
  it('returns null when the backend has no tunnel to give', async () => {
    await expect(resolveNamedTunnel(ctx, vi.fn().mockResolvedValue(null))).resolves.toBeNull();
  });

  it('returns null when the backend call fails outright', async () => {
    const fetchTunnel = vi.fn().mockRejectedValue(new Error('502'));
    await expect(resolveNamedTunnel(ctx, fetchTunnel)).resolves.toBeNull();
  });

  it('returns null on a half-filled response rather than spawning a broken tunnel', async () => {
    const fetchTunnel = vi.fn().mockResolvedValue({ hostname: 'x.example', token: '' });
    await expect(resolveNamedTunnel(ctx, fetchTunnel)).resolves.toBeNull();
  });

  // An older backend has no such route. That is not an error state — it is
  // simply a deployment that predates this, and it must degrade silently.
  it('returns null on a 404 from a backend that predates the route', async () => {
    const err = Object.assign(new Error('Not Found'), { statusCode: 404 });
    await expect(resolveNamedTunnel(ctx, vi.fn().mockRejectedValue(err))).resolves.toBeNull();
  });

  it('does not ask the backend without a plugin auth token', async () => {
    const fetchTunnel = vi.fn();
    await expect(
      resolveNamedTunnel({ ...ctx, pluginAuthToken: '' }, fetchTunnel),
    ).resolves.toBeNull();
    // The route is plugin-auth gated; calling it unauthenticated can only 401.
    expect(fetchTunnel).not.toHaveBeenCalled();
  });
});
