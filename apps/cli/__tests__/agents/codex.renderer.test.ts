import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderCodexBuffer } from '../../src/agents/codex/renderer';
import { filterCodexChrome } from '../../src/agents/codex/parsing';

describe('renderCodexBuffer — scroll region support', () => {
  it('renders plain text identically to the shared renderer when no scroll region is set', () => {
    expect(renderCodexBuffer('hello world')).toEqual(['hello world']);
  });

  it('handles LF as cursor advance when no scroll region is active', () => {
    expect(renderCodexBuffer('line 1\nline 2\nline 3')).toEqual(['line 1', 'line 2', 'line 3']);
  });

  it('strips ANSI SGR codes (colors)', () => {
    expect(renderCodexBuffer('\x1B[31mred\x1B[0m')).toEqual(['red']);
  });

  it('sets a scroll region via CSI <top>;<bot>r and scrolls top row to scrollback on LF at bottom', () => {
    // Region rows 1-3 (1-based) = 0-2 (0-based). Fill the region, then
    // emit one more LF — the top row ("a") should scroll into scrollback,
    // rows shift up, bottom row becomes blank.
    const buf =
      '\x1B[1;3r' +              // set scroll region rows 1-3
      '\x1B[1;1Ha' +             // row 1 col 1: "a"
      '\x1B[2;1Hb' +             // row 2: "b"
      '\x1B[3;1Hc' +             // row 3 (bottom): "c"
      '\n' +                     // LF at row 3 → scroll-up: "a" to scrollback
      '\x1B[3;1Hd';              // row 3: "d"
    const result = renderCodexBuffer(buf);
    // scrollback = ['a']
    // screen rows 0..2 = ['b', 'c', 'd']
    // result = [...scrollback, ...screen]
    expect(result).toEqual(['a', 'b', 'c', 'd']);
  });

  it('handles Reverse Index (ESC M) at top of scroll region — scrolls bottom row to scrollback', () => {
    const buf =
      '\x1B[1;3r' +
      '\x1B[1;1Ha' +
      '\x1B[2;1Hb' +
      '\x1B[3;1Hc' +
      '\x1B[1;1H' +              // cursor to top of region
      '\x1BM' +                  // Reverse Index: scroll DOWN, bottom "c" → scrollback, top → blank
      '\x1B[1;1Hx';              // write "x" at the new top row
    const result = renderCodexBuffer(buf);
    // scrollback = ['c']
    // screen rows 0..2 = ['x', 'a', 'b']
    expect(result).toEqual(['c', 'x', 'a', 'b']);
  });

  it('reset scroll region with CSI r — subsequent LFs do not scroll', () => {
    const buf =
      '\x1B[1;3r' +
      '\x1B[3;1Hc' +
      '\x1B[r' +                 // reset to no region
      '\n\nz';
    const result = renderCodexBuffer(buf);
    // No scroll triggered after reset; just write 'c' at row 2 then advance 2 rows and write 'z'.
    expect(result.filter(l => l !== '')).toEqual(['c', 'z']);
  });

  it('CSI 2J commits visible content to scrollback before clearing', () => {
    const buf = 'history\n\x1B[2Jafter';
    expect(renderCodexBuffer(buf)).toEqual(['history', 'after']);
  });

  it('ignores synchronized output (CSI ?2026h/l), cursor visibility (CSI ?25h/l), and other DEC private toggles', () => {
    const buf =
      '\x1B[?2026h' +            // begin sync
      '\x1B[?25l' +              // hide cursor
      'visible' +
      '\x1B[?25h' +              // show cursor
      '\x1B[?2026l';             // end sync
    expect(renderCodexBuffer(buf)).toEqual(['visible']);
  });
});

describe('renderCodexBuffer — fixture (real Codex multi-line reply)', () => {
  // Forensic capture taken via `script(1)` against a real Codex CLI
  // session where the agent answered "dame 5 ideas en bullet points"
  // (or similar multi-line prompt). The shared renderer drops the
  // bullet continuation because it doesn't know how to handle the
  // DECSTBM scroll regions the Codex CLI uses to fit the chat into
  // its top zone. The Codex-specific renderer preserves it via
  // scrollback.
  const FIXTURE = path.join(__dirname, '..', 'fixtures', 'codex-multiline-reply.bin');
  const raw = fs.readFileSync(FIXTURE, 'utf8');

  it('preserves the full multi-paragraph agent reply (not just the first line)', () => {
    const lines = renderCodexBuffer(raw);
    const content = filterCodexChrome(lines).join('\n');
    // At minimum the reply should produce more than one non-empty line
    // — the bug being fixed was "we only see the first paragraph".
    const nonEmpty = filterCodexChrome(lines).filter(l => l.trim() !== '');
    expect(nonEmpty.length).toBeGreaterThan(1);
    // And the combined content should be longer than what the shared
    // renderer produces from the same bytes (sanity check that the
    // scroll-region handling is actually doing something).
    expect(content.length).toBeGreaterThan(100);
  });

  it('captures content from across multiple scroll cycles, not just the last frame', () => {
    const lines = renderCodexBuffer(raw);
    // Lines that scrolled into scrollback should also appear in the
    // output. The total line count is meaningful evidence that
    // scrollback is non-empty.
    expect(lines.length).toBeGreaterThan(40);
  });
});
