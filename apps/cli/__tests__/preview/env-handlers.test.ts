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

/**
 * `env_parse` — pasting a whole `.env` instead of typing variables one by one.
 *
 * WHY IT EXISTS: configuring an app that already has a `.env` meant copying
 * each variable from the laptop to the phone and typing it in, one at a time.
 * Owner feedback, 2026-09-01.
 *
 * ⚠️ IT DOES NOT WRITE. `env_write` still owns the disk, so there is exactly
 * one writer and the user reviews what was parsed before anything lands. That
 * is the difference between "import" and "clobber my working .env".
 *
 * ⚠️ The parse itself stays here rather than on the phone because `dotenv.ts`
 * is the only owner of `.env` syntax. A second parser would drift, and the
 * drift would show up as a subtly wrong value in the file the dev server
 * reads — a failure that looks like the app's bug.
 */
describe('env_parse', () => {
  it('parses a pasted blob into vars without touching the file', async () => {
    const sendResult = vi.fn();
    await handlers.env_parse(makeCtx(sendResult), { id: 'p1' } as any, {
      content: 'A=1\nB=2\n',
    } as any);
    expect(sendResult).toHaveBeenCalledWith('p1', 'completed', {
      vars: [{ key: 'A', value: '1' }, { key: 'B', value: '2' }],
      added: 2,
      updated: 0,
      unrecognized: 0,
    });
    // Nothing written — the disk is `env_write`'s job.
    await expect(fs.readFile(path.join(dir, '.env'), 'utf8')).rejects.toThrow();
  });

  it('merges over the existing .env by default — a partial paste is the common case', async () => {
    await fs.writeFile(path.join(dir, '.env'), 'KEEP=me\nA=old\n');
    const sendResult = vi.fn();
    await handlers.env_parse(makeCtx(sendResult), { id: 'p2' } as any, {
      content: 'A=new\nNEW=1\n',
    } as any);
    const res = sendResult.mock.calls[0][2];
    // The variable the paste never mentioned survives.
    expect(res.vars).toEqual([
      { key: 'KEEP', value: 'me' },
      { key: 'A', value: 'new' },
      { key: 'NEW', value: '1' },
    ]);
    expect(res.added).toBe(1);
    expect(res.updated).toBe(1);
  });

  it('replace drops what the paste does not mention — opt-in only', async () => {
    await fs.writeFile(path.join(dir, '.env'), 'GONE=1\n');
    const sendResult = vi.fn();
    await handlers.env_parse(makeCtx(sendResult), { id: 'p3' } as any, {
      content: 'ONLY=1\n',
      mode: 'replace',
    } as any);
    expect(sendResult.mock.calls[0][2].vars).toEqual([{ key: 'ONLY', value: '1' }]);
  });

  it('a bad line does NOT fail the import, and is NOT dropped in silence', async () => {
    // Refusing 2 good variables because of one stray line is the exact tedium
    // this feature removes. But `parseDotenv` drops an invalid key with a bare
    // `continue`, and on a 40-variable paste nobody can eyeball what went
    // missing — so the shortfall has to be reported.
    const sendResult = vi.fn();
    await handlers.env_parse(makeCtx(sendResult), { id: 'p4' } as any, {
      content: 'GOOD=1\n1BAD=x\nALSO_GOOD=2\n',
    } as any);
    const res = sendResult.mock.calls[0][2];
    expect(res.vars).toEqual([
      { key: 'GOOD', value: '1' },
      { key: 'ALSO_GOOD', value: '2' },
    ]);
    expect(res.unrecognized).toBe(1);
  });

  it('does not cry wolf: a clean paste reports nothing unrecognized', async () => {
    const sendResult = vi.fn();
    await handlers.env_parse(makeCtx(sendResult), { id: 'p4b' } as any, {
      content: '# comment\n\nexport A="x y"\nB=has=equals\nA=dupe\n',
    } as any);
    // The duplicate is not a loss — last-wins is correct — so it must not be
    // counted as an unrecognized line.
    expect(sendResult.mock.calls[0][2].unrecognized).toBe(0);
  });

  it('last wins on a duplicated key, like a shell sourcing the file', async () => {
    const sendResult = vi.fn();
    await handlers.env_parse(makeCtx(sendResult), { id: 'p5' } as any, {
      content: 'A=first\nA=second\n',
    } as any);
    expect(sendResult.mock.calls[0][2].vars).toEqual([{ key: 'A', value: 'second' }]);
  });

  it('preserves the quoting and `export ` cases the one parser handles', async () => {
    // The whole reason this runs CLI-side: these are the cases a second,
    // phone-side parser would get subtly wrong.
    const sendResult = vi.fn();
    await handlers.env_parse(makeCtx(sendResult), { id: 'p6' } as any, {
      content: 'export A="has spaces"\nB=has=equals\n# comment\n',
    } as any);
    expect(sendResult.mock.calls[0][2].vars).toEqual([
      { key: 'A', value: 'has spaces' },
      { key: 'B', value: 'has=equals' },
    ]);
  });

  it('rejects a missing blob rather than silently importing nothing', async () => {
    const sendResult = vi.fn();
    await handlers.env_parse(makeCtx(sendResult), { id: 'p7' } as any, {} as any);
    expect(sendResult).toHaveBeenCalledWith('p7', 'failed', { error: 'Missing content' });
  });
});
