import { describe, it, expect, vi } from 'vitest';
vi.mock('../../src/services/spawn-and-capture', () => ({
  spawnAndCapture: vi.fn(async () => '{"framework":"next","port":3000}'),
}));
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
