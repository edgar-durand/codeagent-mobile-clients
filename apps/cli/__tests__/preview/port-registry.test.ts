/**
 * Persistent preview-port registry (Rafael's 2026-07-14 feedback): a dev
 * server orphaned by a CLI restart / hard-kill must be reclaimable by the
 * NEXT CLI so the user never has to ask the agent to free the port. The
 * registry records OUR ports across process lifetimes; reclaim only ever
 * kills a tree WE recorded, never a foreign squatter.
 *
 * Reclaim is cross-platform: POSIX signals the detached process group
 * (`-pgid`); Windows has no process groups, so it `taskkill /F /T`s the
 * recorded leader pid + its child tree. Each behaviour test forces
 * `process.platform` so it is deterministic on any CI host (the Windows
 * runners used to fail because these tests assumed POSIX semantics).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as osReal from 'os';
import * as fs from 'fs';
import * as path from 'path';

// child_process.spawnSync is the Windows kill path (taskkill). Hoisted so the
// vi.mock factory below can reference the spy.
const { taskkillMock } = vi.hoisted(() => ({ taskkillMock: vi.fn(() => ({ status: 0 })) }));
vi.mock('child_process', async (importActual) => {
  const actual = await importActual<typeof import('child_process')>();
  return { ...actual, spawnSync: taskkillMock };
});

// homedir() can't be spied under vitest ESM (namespace not configurable), so
// mock the module with a factory that reads a mutable closure var lazily.
let tmpHome = '';
vi.mock('os', async (importActual) => {
  const actual = await importActual<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => tmpHome };
});

const ORIG_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(osReal.tmpdir(), 'codeam-portreg-'));
  taskkillMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  setPlatform(ORIG_PLATFORM);
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

  it('POSIX: reclaims an OWN orphan by SIGTERMing the group, returns true', async () => {
    setPlatform('linux');
    const reg = await load();
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((_pid: number, _signal?: string | number) => true);

    reg.recordPreviewPort(3000, 777, 'sess-1', 111);
    expect(reg.reclaimOwnOrphanPort(3000)).toBe(true);

    // Signalled the whole group (negative pid) with SIGTERM.
    expect(killSpy).toHaveBeenCalledWith(-777, 'SIGTERM');
    // POSIX never shells out to taskkill.
    expect(taskkillMock).not.toHaveBeenCalled();
    // Record dropped after reclaim.
    expect(JSON.parse(fs.readFileSync(regFile(), 'utf8'))).toEqual({});
  });

  it('Windows: reclaims an OWN orphan via `taskkill /F /T`, returns true', async () => {
    setPlatform('win32');
    const reg = await load();
    // Liveness probe kill(pid, 0) → alive; no kill-signal ever sent on Windows.
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((_pid: number, _signal?: string | number) => true);

    reg.recordPreviewPort(3000, 777, 'sess-1', 111);
    expect(reg.reclaimOwnOrphanPort(3000)).toBe(true);

    // Force-killed the leader pid AND its child tree via taskkill.
    expect(taskkillMock).toHaveBeenCalledWith(
      'taskkill',
      ['/F', '/T', '/PID', '777'],
      expect.objectContaining({ stdio: 'ignore' }),
    );
    // Liveness probed the positive pid (no process groups on Windows).
    expect(killSpy).toHaveBeenCalledWith(777, 0);
    expect(JSON.parse(fs.readFileSync(regFile(), 'utf8'))).toEqual({});
  });

  it('does NOT reclaim a foreign port (never recorded) — returns false, kills nothing', async () => {
    setPlatform('linux');
    const reg = await load();
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never);

    expect(reg.reclaimOwnOrphanPort(3000)).toBe(false);
    // No SIGTERM/SIGKILL to any group we didn't own, and no taskkill.
    expect(
      killSpy.mock.calls.filter(([, sig]) => sig === 'SIGTERM' || sig === 'SIGKILL'),
    ).toHaveLength(0);
    expect(taskkillMock).not.toHaveBeenCalled();
  });

  it('POSIX: cleans up a stale record whose group is already dead, returns false', async () => {
    setPlatform('linux');
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
    expect(taskkillMock).not.toHaveBeenCalled();
    // Stale entry pruned.
    expect(JSON.parse(fs.readFileSync(regFile(), 'utf8'))).toEqual({});
  });

  it('Windows: cleans up a stale record whose process is already dead, returns false', async () => {
    setPlatform('win32');
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
    // Dead process → never taskkill; stale entry pruned.
    expect(taskkillMock).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(regFile(), 'utf8'))).toEqual({});
  });

  it('treats EPERM on the liveness probe as alive (reclaims)', async () => {
    setPlatform('linux');
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
