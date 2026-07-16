import { describe, it, expect } from 'vitest';
import {
  detectTuiChromeLeak,
  hasTuiChromeLeak,
} from '../../../src/agents/acp/chrome-leak-detector';

describe('detectTuiChromeLeak', () => {
  it('is clean on legitimate assistant prose (no false positives)', () => {
    const prose = [
      "Here's the fix for your schema.prisma:",
      '',
      'I added `previewFeatures = ["queryCompiler", "driverAdapters"]` to the',
      'generator block. Run `npx prisma generate` to regenerate the client.',
      '',
      '- First, migrate the dev database',
      '- Then restart the dev server',
    ].join('\n');
    expect(detectTuiChromeLeak(prose)).toEqual([]);
    expect(hasTuiChromeLeak(prose)).toBe(false);
  });

  it("flags the v2.1.211 'What's new / Welcome back' changelog banner", () => {
    const leaked = 'Welcome back!\nWhat’s new\nAdded --forward-subagent-text flag and';
    const hits = detectTuiChromeLeak(leaked);
    expect(hits.map((h) => h.marker)).toEqual(
      expect.arrayContaining(['whats_new_banner']),
    );
  });

  it('flags the Claude Code version banner', () => {
    expect(hasTuiChromeLeak('Claude Code v2.1.211')).toBe(true);
    expect(detectTuiChromeLeak('Claude Code v2.1.211')[0].marker).toBe('version_banner');
  });

  it('flags the TUI status line', () => {
    const hits = detectTuiChromeLeak('manual mode on · ? for shortcuts · ← for agents');
    expect(hits[0].marker).toBe('status_line');
  });

  it('flags the leaked permission-dialog footer', () => {
    expect(hasTuiChromeLeak('Esc to cancel · Tab to amend')).toBe(true);
  });

  it('flags a pure box-drawing separator row (the "empty line" rules)', () => {
    const rule = '─'.repeat(40);
    expect(detectTuiChromeLeak(rule)[0].marker).toBe('box_drawing_rule');
  });

  it('does NOT flag a normal markdown bullet or a code-fence dash line', () => {
    // ASCII hyphens are legitimate prose/markdown — only box-drawing glyphs count.
    expect(hasTuiChromeLeak('- do the thing\n--- a horizontal rule ---')).toBe(false);
  });
});
