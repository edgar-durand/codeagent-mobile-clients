import { describe, it, expect } from 'vitest';
import { renderToLines } from '../src';

describe('renderToLines — virtual terminal', () => {
  it('renders plain text as a single line', () => {
    expect(renderToLines('hello world')).toEqual(['hello world']);
  });

  it('splits on LF into separate screen lines', () => {
    expect(renderToLines('line 1\nline 2\nline 3')).toEqual(['line 1', 'line 2', 'line 3']);
  });

  it('treats CR alone as a carriage return (overwrite from col 0)', () => {
    // "abc\rX" should end up as "Xbc" because CR resets the cursor.
    expect(renderToLines('abc\rX')).toEqual(['Xbc']);
  });

  it('treats CRLF as a newline', () => {
    expect(renderToLines('line 1\r\nline 2')).toEqual(['line 1', 'line 2']);
  });

  it('strips ANSI CSI colour / SGR codes', () => {
    // \x1B[31m red \x1B[0m — SGR codes produce no visible output.
    expect(renderToLines('\x1B[31mred\x1B[0m')).toEqual(['red']);
  });

  it('handles erase line (CSI K) after CR — Claude Ink pattern', () => {
    // Ink's highlight-overwrite: "  1. Label\r❯" → cursor back to col 0,
    // then "❯" overwrites the first char.
    expect(renderToLines('  1. Label\r❯')).toEqual(['❯ 1. Label']);
  });

  it('clears screen on CSI 2J', () => {
    expect(renderToLines('before\n\x1B[2Jafter')).toEqual(['after']);
  });

  it('swallows OSC sequences (terminal title, hyperlinks)', () => {
    // OSC 0 ; title BEL — should not appear in output.
    expect(renderToLines('\x1B]0;my title\x07visible')).toEqual(['visible']);
  });
});
