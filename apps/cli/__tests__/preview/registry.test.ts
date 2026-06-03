import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activePreviews,
  killAllPreviews,
  killPreview,
  registerPreview,
} from '../../src/services/preview';
import type { ActivePreview } from '../../src/services/preview';

type FakeChild = EventEmitter & { kill: ReturnType<typeof vi.fn> };

function makeFakeChild(): FakeChild {
  const e = new EventEmitter() as FakeChild;
  e.kill = vi.fn();
  return e;
}

function makePreview(sessionId: string, opts: { withTunnel: boolean }): ActivePreview {
  return {
    sessionId,
    devServer: makeFakeChild() as unknown as ActivePreview['devServer'],
    tunnel: opts.withTunnel
      ? (makeFakeChild() as unknown as ActivePreview['tunnel'])
      : null,
    url: opts.withTunnel ? 'https://x.trycloudflare.com' : '',
    framework: 'Vite',
  };
}

describe('preview registry', () => {
  beforeEach(() => {
    activePreviews.clear();
  });

  it('registers and retrieves by sessionId', () => {
    const preview = makePreview('sess-1', { withTunnel: true });
    registerPreview('sess-1', preview);
    expect(activePreviews.get('sess-1')?.url).toBe('https://x.trycloudflare.com');
  });

  it('killPreview kills the tunnel first, then the dev server', async () => {
    const preview = makePreview('sess-2', { withTunnel: true });
    registerPreview('sess-2', preview);
    await killPreview('sess-2');
    expect(preview.tunnel!.kill).toHaveBeenCalledWith('SIGTERM');
    expect(preview.devServer.kill).toHaveBeenCalledWith('SIGTERM');
    expect(activePreviews.has('sess-2')).toBe(false);
  });

  it('killPreview is a no-op for unknown sessionIds', async () => {
    await expect(killPreview('does-not-exist')).resolves.toBeUndefined();
  });

  it('killAllPreviews walks every session', async () => {
    registerPreview('a', makePreview('a', { withTunnel: false }));
    registerPreview('b', makePreview('b', { withTunnel: false }));
    await killAllPreviews();
    expect(activePreviews.size).toBe(0);
  });
});
