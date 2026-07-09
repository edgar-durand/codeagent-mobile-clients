import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../src/services/spawn-and-capture', () => ({
  spawnAndCapture: vi.fn(async () => '{"framework":"next","port":3000}'),
}));
// spawnSync backs cursor's `create-chat` session-id pre-mint. Override ONLY
// spawnSync (keep every other child_process export) so the baton pre-mint path
// is unit-testable without a real cursor-agent binary.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn() };
});
import { spawnSync } from 'node:child_process';
const spawnSyncMock = spawnSync as unknown as ReturnType<typeof vi.fn>;
import { CursorRuntimeStrategy } from '../../src/agents/cursor/runtime';
import { spawnAndCapture } from '../../src/services/spawn-and-capture';
import type { OsStrategy } from '../../src/os';
import {
  filterCursorChrome,
  detectCursorSelector,
} from '../../src/agents/cursor/parsing';
import { LinuxOsStrategy } from '../../src/os';

describe('CursorRuntimeStrategy contract', () => {
  const runtime = new CursorRuntimeStrategy(new LinuxOsStrategy());

  it('reports mode="interactive" and id="cursor"', () => {
    expect(runtime.mode).toBe('interactive');
    expect(runtime.id).toBe('cursor');
    expect(runtime.meta.displayName).toBe('Cursor Agent');
    expect(runtime.meta.binaryName).toBe('cursor-agent');
  });

  it('resumeLaunchArgs returns Claude-style --resume <id> (no auto bypass)', () => {
    expect(runtime.resumeLaunchArgs('sess-abc')).toEqual(['--resume', 'sess-abc']);
    // Cursor ignores opts.auto today — same args for both modes.
    expect(runtime.resumeLaunchArgs('sess-abc', { auto: true })).toEqual([
      '--resume',
      'sess-abc',
    ]);
  });

  it('listModels returns the Cursor catalog', async () => {
    const models = await runtime.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].contextWindow).toBeGreaterThan(0);
    const ids = models.map((m) => m.id);
    expect(ids).toContain('cursor-default');
  });

  it('changeModelInstruction emits /model <id> PTY input', () => {
    expect(runtime.changeModelInstruction('cursor-default')).toEqual({
      type: 'pty',
      ptyInput: '/model cursor-default\r',
    });
  });

  it('credentialLocator points at ~/.cursor/auth.json', () => {
    const loc = runtime.credentialLocator();
    expect(loc.publicId).toBe('cursor');
    expect(loc.vendor).toBe('Cursor');
    expect(loc.hint).toBe('~/.cursor/auth.json');
    // Normalize the OS separator before comparing — on Windows the
    // joined path is `…\.cursor\auth.json`, on POSIX `…/.cursor/auth.json`.
    // Both should end at the same logical segment.
    const tail = loc.watchPaths()[0].replace(/\\/g, '/');
    expect(tail.endsWith('.cursor/auth.json')).toBe(true);
  });

  it('prepareLaunch throws with install guidance when cursor-agent is missing', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '/var/empty';
    try {
      const r = new CursorRuntimeStrategy(new LinuxOsStrategy());
      await expect(r.prepareLaunch()).rejects.toThrow(/cursor.com/i);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  describe('prepareLaunch session-id pre-mint (baton)', () => {
    const fakeOs = {
      findInPath: () => '/usr/bin/cursor-agent',
      buildLaunch: (cmd: string, args: string[] = []) => ({ cmd, args }),
    } as unknown as OsStrategy;

    beforeEach(() => spawnSyncMock.mockReset());

    it('pre-mints a chat id via `create-chat` and launches the TUI with --resume <id>', async () => {
      const id = '7d3c1303-434b-4f24-a174-1baa8e4a625e';
      spawnSyncMock.mockReturnValue({ status: 0, stdout: `${id}\n`, stderr: '' });
      const r = new CursorRuntimeStrategy(fakeOs);
      const launch = await r.prepareLaunch();
      // create-chat was the command we ran to mint the id.
      expect(spawnSyncMock).toHaveBeenCalledWith(
        '/usr/bin/cursor-agent',
        ['create-chat'],
        expect.objectContaining({ encoding: 'utf8' }),
      );
      expect(launch.sessionId).toBe(id);
      expect(launch.args).toEqual(['--resume', id]);
    });

    it('falls back to a fresh launch (no sessionId) when create-chat fails', async () => {
      spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: 'not logged in' });
      const r = new CursorRuntimeStrategy(fakeOs);
      const launch = await r.prepareLaunch();
      expect(launch.sessionId).toBeUndefined();
      expect(launch.args).toEqual([]);
    });

    it('falls back when create-chat prints no parseable chat id', async () => {
      spawnSyncMock.mockReturnValue({ status: 0, stdout: 'welcome!\n', stderr: '' });
      const r = new CursorRuntimeStrategy(fakeOs);
      const launch = await r.prepareLaunch();
      expect(launch.sessionId).toBeUndefined();
      expect(launch.args).toEqual([]);
    });

    it('prepareResumeLaunch rebuilds a clean --resume <id> (no duplicate flag)', () => {
      const r = new CursorRuntimeStrategy(fakeOs);
      expect(r.prepareResumeLaunch!('sess-xyz')).toEqual({
        cmd: '/usr/bin/cursor-agent',
        args: ['--resume', 'sess-xyz'],
      });
    });
  });

  it('fetchWeeklyUsage returns null (no public RPC yet)', async () => {
    await expect(runtime.fetchWeeklyUsage()).resolves.toBeNull();
  });

  it('generateOneShot runs cursor-agent --print --force --trust <prompt> (powers preview detection)', async () => {
    const fakeOs = {
      findInPath: () => '/usr/bin/cursor-agent',
      buildLaunch: (cmd: string, args: string[] = []) => ({ cmd, args }),
    } as unknown as OsStrategy;
    const r = new CursorRuntimeStrategy(fakeOs);
    const out = await r.generateOneShot!('detect the framework');
    expect(out).toBe('{"framework":"next","port":3000}');
    const [cmd, args] = (spawnAndCapture as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(cmd).toBe('/usr/bin/cursor-agent');
    // --trust bypasses the headless workspace-trust gate; --force auto-allows tools.
    expect(args).toEqual(['--print', '--force', '--trust', 'detect the framework']);
  });

  it('generateOneShot returns null when cursor-agent is not on PATH', async () => {
    const fakeOs = { findInPath: () => null } as unknown as OsStrategy;
    const r = new CursorRuntimeStrategy(fakeOs);
    await expect(r.generateOneShot!('x')).resolves.toBeNull();
  });
});

describe('cursor/parsing', () => {
  it('filterCursorChrome drops spinner glyphs and status hints', () => {
    const lines = [
      '⠁ thinking…',
      'Hello from Cursor',
      'Esc to interrupt · ↑↓ to navigate',
      '',
      'Another line',
    ];
    expect(filterCursorChrome(lines)).toEqual(['Hello from Cursor', 'Another line']);
  });

  it('detectCursorSelector finds a numbered selector', () => {
    const lines = [
      '  1. First option',
      '❯ 2. Second option',
      '  3. Third option',
    ];
    const sel = detectCursorSelector(lines);
    expect(sel?.options).toEqual(['First option', 'Second option', 'Third option']);
    expect(sel?.currentIndex).toBe(1);
  });

  it('detectCursorSelector returns null when no pointer is present', () => {
    expect(detectCursorSelector(['plain text', 'no selector here'])).toBeNull();
  });
});
