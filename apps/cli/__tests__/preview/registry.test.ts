import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activePreviews,
  killAllPreviews,
  killPreview,
  killProcessTree,
  registerPreview,
} from '../../src/services/preview';
import type { ActivePreview } from '../../src/services/preview';

type FakeChild = EventEmitter & { kill: ReturnType<typeof vi.fn>; pid?: number };

let nextPid = 100_000;

function makeFakeChild(): FakeChild {
  const e = new EventEmitter() as FakeChild;
  e.kill = vi.fn();
  // A real-ish but guaranteed-dead pid so the group-kill path runs.
  e.pid = nextPid++;
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
    cwd: '/tmp/repo',
    detection: {
      framework: 'Vite',
      command: 'npm',
      args: ['run', 'dev'],
      port: 5173,
      ready_pattern: 'ready',
    },
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

  it('killPreview group-kills the tunnel first, then the dev server', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const preview = makePreview('sess-2', { withTunnel: true });
      registerPreview('sess-2', preview);
      await killPreview('sess-2');
      if (process.platform === 'win32') {
        // No POSIX process groups on Windows — killProcessTree falls back to
        // a direct child.kill and never touches process.kill(-pid).
        expect(killSpy).not.toHaveBeenCalled();
        expect(preview.tunnel!.kill).toHaveBeenCalledWith('SIGTERM');
        expect(preview.devServer.kill).toHaveBeenCalledWith('SIGTERM');
      } else {
        // POSIX: both are torn down via their process group (negative pid).
        expect(killSpy).toHaveBeenCalledWith(-preview.tunnel!.pid!, 'SIGTERM');
        expect(killSpy).toHaveBeenCalledWith(-preview.devServer.pid!, 'SIGTERM');
        // Group-kill succeeded, so the direct child.kill is NOT used.
        expect(preview.devServer.kill).not.toHaveBeenCalled();
      }
      expect(activePreviews.has('sess-2')).toBe(false);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('killPreview is a no-op for unknown sessionIds', async () => {
    await expect(killPreview('does-not-exist')).resolves.toBeUndefined();
  });

  it('killAllPreviews walks every session', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      registerPreview('a', makePreview('a', { withTunnel: false }));
      registerPreview('b', makePreview('b', { withTunnel: false }));
      await killAllPreviews();
      expect(activePreviews.size).toBe(0);
    } finally {
      killSpy.mockRestore();
    }
  });
});

describe('killProcessTree', () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    killSpy?.mockRestore();
  });

  it('signals the whole process group via the negative pid (POSIX)', () => {
    if (process.platform === 'win32') return; // POSIX-only behaviour
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const child = makeFakeChild();
    killProcessTree(child as unknown as ActivePreview['devServer'], 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(-child.pid!, 'SIGTERM');
    // Group signal succeeded → no direct fallback kill.
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('falls back to a direct child kill when the group signal throws', () => {
    if (process.platform === 'win32') return;
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    const child = makeFakeChild();
    killProcessTree(child as unknown as ActivePreview['devServer'], 'SIGKILL');
    expect(killSpy).toHaveBeenCalledWith(-child.pid!, 'SIGKILL');
    // Group gone → direct kill is the fallback.
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('is a no-op when the child has no pid', () => {
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const child = new EventEmitter() as FakeChild;
    child.kill = vi.fn();
    child.pid = undefined;
    killProcessTree(child as unknown as ActivePreview['devServer'], 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });
});
