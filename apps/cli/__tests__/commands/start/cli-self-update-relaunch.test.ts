/**
 * Regression test for the LOCAL relaunch seam of the `cli_self_update` handler
 * (`defaultCliUpdateDeps.relaunch`).
 *
 * The bug: a local interactive session (`codeam pair`) tapped "Update" in the
 * app, the CLI installed the new version, then re-exec'd with a DETACHED
 * `spawn(process.execPath, [process.argv[1], ...])` + `process.exit(0)`. The
 * detached child left the parent's process group, the parent left the
 * foreground, the shell reclaimed the controlling terminal, and the interactive
 * TUI child got SIGTTIN and never came up — "closed the session but couldn't
 * relaunch it".
 *
 * The fix mirrors the proven `updateNotifier.maybeAutoUpdate`: a SYNCHRONOUS,
 * foreground re-exec via `codeam` from PATH (the freshly installed binary),
 * keeping the controlling terminal, then exit with the child's status.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// Keep module-load side-effect-free (handlers.ts imports the pairing service).
vi.mock('../../../src/services/pairing.service', () => ({
  postCliUpdateEvent: vi.fn().mockResolvedValue({ ok: true }),
  postLinkCredential: vi.fn(),
  postAiResult: vi.fn(),
  postPreviewEvent: vi.fn(),
  postHeadroomEvent: vi.fn(),
  postBeadsEvent: vi.fn(),
  _transport: { postJson: vi.fn(), getJson: vi.fn(), postJsonAuthed: vi.fn() },
}));

// Mock child_process so no real process is spawned and the detached/sync
// decision is observable.
vi.mock('child_process', async (importActual) => {
  const actual = await importActual<typeof import('child_process')>();
  return { ...actual, spawnSync: vi.fn(), spawn: vi.fn() };
});

import { spawnSync, spawn } from 'child_process';
import { defaultCliUpdateDeps } from '../../../src/commands/start/handlers';

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(spawnSync).mockReset();
  vi.mocked(spawn).mockReset();
});

describe('defaultCliUpdateDeps.relaunch — local interactive re-exec', () => {
  it('re-execs SYNCHRONOUSLY via `codeam` from PATH, not a detached argv re-exec', () => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as never);

    expect(() => defaultCliUpdateDeps.relaunch(['pair'])).toThrow('exit:0');

    // Foreground, in-place: spawnSync('codeam', args, {stdio:'inherit'}).
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync).toHaveBeenCalledWith(
      'codeam',
      ['pair'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
    // The old detached re-exec must be gone — no async spawn, no argv[1].
    expect(spawn).not.toHaveBeenCalled();
  });

  it('exits with the child process status', () => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    vi.mocked(spawnSync).mockReturnValue({ status: 3 } as never);

    expect(() => defaultCliUpdateDeps.relaunch(['start'])).toThrow('exit:3');
  });

  it('exits 0 when the child status is null (signalled/unknown)', () => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    vi.mocked(spawnSync).mockReturnValue({ status: null } as never);

    expect(() => defaultCliUpdateDeps.relaunch(['pair'])).toThrow('exit:0');
  });
});
