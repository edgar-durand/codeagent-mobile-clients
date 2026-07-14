/**
 * Persistent preview-port registry (Rafael's 2026-07-14 feedback): a dev
 * server orphaned by a CLI restart / hard-kill must be reclaimable by the
 * NEXT CLI so the user never has to ask the agent to free the port. The
 * registry records OUR ports across process lifetimes; reclaim only ever
 * kills a group WE recorded, never a foreign squatter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as osReal from 'os';
import * as fs from 'fs';
import * as path from 'path';

// homedir() can't be spied under vitest ESM (namespace not configurable), so
// mock the module with a factory that reads a mutable closure var lazily.
let tmpHome = '';
vi.mock('os', async (importActual) => {
  const actual = await importActual<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => tmpHome };
});

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(osReal.tmpdir(), 'codeam-portreg-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

async function load() {
  vi.resetModules();
  return import('../../src/services/preview/port-registry');
}

function regFile(): string {
  return path.join(tmpHome, '.codeam', 'preview-ports.json');
}

describe('preview port registry', () => {
  it('records and forgets a port ownership entry', async () => {
    const reg = await load();
    reg.recordPreviewPort(3000, 12345, 'sess-1', 111);
    expect(JSON.parse(fs.readFileSync(regFile(), 'utf8'))).toEqual({
      '3000': { pgid: 12345, sessionId: 'sess-1', ts: 111 },
    });

    reg.forgetPreviewPort(3000);
    expect(JSON.parse(fs.readFileSync(regFile(), 'utf8'))).toEqual({});
  });

  it('recordPreviewPort is a no-op when the dev pid is undefined', async () => {
    const reg = await load();
    reg.recordPreviewPort(3000, undefined, 'sess-1', 111);
    expect(fs.existsSync(regFile())).toBe(false);
  });

  it('reclaims an OWN orphan: SIGTERMs the recorded group and returns true', async () => {
    const reg = await load();
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((pid: number, signal?: string | number) => {
        // kill(pid, 0) liveness probe → alive.
        if (signal === 0) return true;
        return true;
      });

    reg.recordPreviewPort(3000, 777, 'sess-1', 111);
    expect(reg.reclaimOwnOrphanPort(3000)).toBe(true);

    // Signalled the whole group (negative pid) with SIGTERM.
    expect(killSpy).toHaveBeenCalledWith(-777, 'SIGTERM');
    // Record dropped after reclaim.
    expect(JSON.parse(fs.readFileSync(regFile(), 'utf8'))).toEqual({});
  });

  it('does NOT reclaim a foreign port (never recorded) — returns false, kills nothing', async () => {
    const reg = await load();
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never);

    expect(reg.reclaimOwnOrphanPort(3000)).toBe(false);
    // No SIGTERM/SIGKILL to any group we didn't own.
    expect(
      killSpy.mock.calls.filter(([, sig]) => sig === 'SIGTERM' || sig === 'SIGKILL'),
    ).toHaveLength(0);
  });

  it('cleans up a stale record whose group is already dead, returns false', async () => {
    const reg = await load();
    vi.spyOn(process, 'kill').mockImplementation((_pid: number, signal?: string | number) => {
      if (signal === 0) {
        const err = new Error('no such process') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    });

    reg.recordPreviewPort(3000, 888, 'sess-1', 111);
    expect(reg.reclaimOwnOrphanPort(3000)).toBe(false);
    // Stale entry pruned.
    expect(JSON.parse(fs.readFileSync(regFile(), 'utf8'))).toEqual({});
  });

  it('treats EPERM on the liveness probe as alive (reclaims)', async () => {
    const reg = await load();
    vi.spyOn(process, 'kill').mockImplementation((_pid: number, signal?: string | number) => {
      if (signal === 0) {
        const err = new Error('operation not permitted') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return true;
    });

    reg.recordPreviewPort(3000, 999, 'sess-1', 111);
    expect(reg.reclaimOwnOrphanPort(3000)).toBe(true);
  });
});
