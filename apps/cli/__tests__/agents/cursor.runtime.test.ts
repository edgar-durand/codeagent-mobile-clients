import { describe, it, expect } from 'vitest';
import { CursorRuntimeStrategy } from '../../src/agents/cursor/runtime';
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
