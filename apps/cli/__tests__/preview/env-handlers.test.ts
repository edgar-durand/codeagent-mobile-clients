import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { ChildProcess } from 'child_process';
import { handlers } from '../../src/commands/start/handlers';
import * as handlersMod from '../../src/commands/start/handlers';
import * as preview from '../../src/services/preview';
import { activePreviews, registerPreview } from '../../src/services/preview';
import type { PreviewDetection } from '@codeam/shared';

function makeCtx(sendResult = vi.fn()) {
  return {
    sessionId: 'sess-1',
    pluginId: 'plug-1',
    pluginAuthToken: 'tok',
    relay: { sendResult },
  } as any;
}

let dir: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'envcfg-'));
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
});
afterEach(async () => {
  cwdSpy.mockRestore();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('env_read', () => {
  it('returns exists:false and empty vars when no .env', async () => {
    const sendResult = vi.fn();
    await handlers.env_read(makeCtx(sendResult), { id: 'c1' } as any, {} as any);
    expect(sendResult).toHaveBeenCalledWith('c1', 'completed', { exists: false, vars: [] });
  });
  it('returns parsed vars when .env exists', async () => {
    await fs.writeFile(path.join(dir, '.env'), 'A=1\nB=2\n');
    const sendResult = vi.fn();
    await handlers.env_read(makeCtx(sendResult), { id: 'c2' } as any, {} as any);
    expect(sendResult).toHaveBeenCalledWith('c2', 'completed', {
      exists: true,
      vars: [{ key: 'A', value: '1' }, { key: 'B', value: '2' }],
    });
  });
});

describe('env_write', () => {
  it('rejects an invalid key', async () => {
    const sendResult = vi.fn();
    await handlers.env_write(makeCtx(sendResult), { id: 'w1' } as any, {
      vars: [{ key: '1BAD', value: 'x' }],
    } as any);
    expect(sendResult).toHaveBeenCalledWith('w1', 'failed', expect.objectContaining({
      error: expect.stringContaining('Invalid key'),
    }));
  });
  it('rejects duplicate keys', async () => {
    const sendResult = vi.fn();
    await handlers.env_write(makeCtx(sendResult), { id: 'w2' } as any, {
      vars: [{ key: 'A', value: '1' }, { key: 'A', value: '2' }],
    } as any);
    expect(sendResult).toHaveBeenCalledWith('w2', 'failed', expect.objectContaining({
      error: expect.stringContaining('Duplicate key'),
    }));
  });
  it('writes the .env and reports the count', async () => {
    const sendResult = vi.fn();
    await handlers.env_write(makeCtx(sendResult), { id: 'w3' } as any, {
      vars: [{ key: 'A', value: '1' }, { key: 'B', value: 'hello world' }],
    } as any);
    expect(sendResult).toHaveBeenCalledWith('w3', 'completed', { ok: true, count: 2 });
    const body = await fs.readFile(path.join(dir, '.env'), 'utf8');
    expect(body).toBe('# Managed by CodeAgent\nA=1\nB="hello world"\n');
    // no temp file left behind
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.includes('.tmp'))).toEqual([]);
  });
});

describe('preview_restart', () => {
  const det: PreviewDetection = {
    framework: 'Vite',
    command: 'npm',
    args: ['run', 'dev'],
    port: 5173,
    ready_pattern: 'Local:',
  };

  // A fake ChildProcess is enough — previewRestartH never touches the
  // devServer itself (killPreview is spied out), it only needs the entry
  // present in the registry to read `.detection` off it.
  function fakeProcess(): ChildProcess {
    return { exitCode: null, kill: vi.fn() } as unknown as ChildProcess;
  }

  beforeEach(() => {
    activePreviews.clear();
  });
  afterEach(() => {
    activePreviews.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('no-ops with restarted:false when no active preview', async () => {
    const sendResult = vi.fn();
    // No registry entry for the session.
    await handlers.preview_restart(makeCtx(sendResult), { id: 'r1' } as any, {} as any);
    expect(sendResult).toHaveBeenCalledWith('r1', 'completed', { restarted: false });
  });

  it('no-ops with restarted:false when pluginAuthToken is missing', async () => {
    registerPreview('sess-1', {
      sessionId: 'sess-1',
      devServer: fakeProcess(),
      tunnel: null,
      url: 'https://x.trycloudflare.com',
      framework: 'Vite',
      cwd: '/tmp/repo',
      detection: det,
    });
    const sendResult = vi.fn();
    const ctx = { ...makeCtx(sendResult), pluginAuthToken: undefined } as any;
    await handlers.preview_restart(ctx, { id: 'r0' } as any, {} as any);
    expect(sendResult).toHaveBeenCalledWith('r0', 'completed', { restarted: false });
  });

  it('kills then re-spawns from the stored detection', async () => {
    vi.useFakeTimers();
    registerPreview('sess-1', {
      sessionId: 'sess-1',
      devServer: fakeProcess(),
      tunnel: null,
      url: 'https://x.trycloudflare.com',
      framework: 'Vite',
      cwd: '/tmp/repo',
      detection: det,
    });
    const kill = vi.spyOn(preview, 'killPreview').mockResolvedValue(undefined);
    // Spy on the bring-up so the REAL dev-server spawn never runs in the test.
    const restart = vi
      .spyOn(handlersMod, 'startPreviewFromDetection')
      .mockReturnValue(undefined);

    const sendResult = vi.fn();
    const p = handlers.preview_restart(makeCtx(sendResult), { id: 'r2' } as any, {} as any);
    // Drive the ~150 ms port-release wait the handler awaits.
    await vi.runAllTimersAsync();
    await p;

    expect(kill).toHaveBeenCalledWith('sess-1');
    expect(restart).toHaveBeenCalledWith(expect.anything(), det, 'tok');
    expect(sendResult).toHaveBeenCalledWith('r2', 'completed', { restarted: true });
  });
});
