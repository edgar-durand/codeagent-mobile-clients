import { describe, it, expect } from 'vitest';
import { filterChrome } from '../src';

describe('filterChrome — context compaction and thinking indicators', () => {
  it('filters standalone compaction notice "↓ N tokens"', () => {
    expect(filterChrome(['↓ 518 tokens'])).toEqual([]);
  });

  it('filters compaction notice with large token count', () => {
    expect(filterChrome(['↓ 12345 tokens'])).toEqual([]);
  });

  it('filters combined compaction + thinking indicator "↓ N tokens · thought for Ns"', () => {
    expect(filterChrome(['↓ 518 tokens · thought for 18s'])).toEqual([]);
  });

  it('filters combined compaction + thinking with larger numbers', () => {
    expect(filterChrome(['↓ 1024 tokens · thought for 120s'])).toEqual([]);
  });

  it('filters standalone extended thinking indicator "thought for Ns"', () => {
    expect(filterChrome(['thought for 18s'])).toEqual([]);
  });

  it('filters standalone extended thinking indicator with multi-digit seconds', () => {
    expect(filterChrome(['thought for 120s'])).toEqual([]);
  });

  it('does NOT filter real content lines that happen to mention tokens', () => {
    const line = 'The model uses 518 tokens per request by default.';
    expect(filterChrome([line])).toEqual([line]);
  });

  it('does NOT filter real content lines that mention thinking', () => {
    const line = 'I was thinking about the best approach here.';
    expect(filterChrome([line])).toEqual([line]);
  });

  it('filters compaction lines while preserving surrounding real content', () => {
    const input = [
      'Here is the updated function:',
      '↓ 518 tokens · thought for 18s',
      'The change was applied successfully.',
    ];
    expect(filterChrome(input)).toEqual([
      'Here is the updated function:',
      'The change was applied successfully.',
    ]);
  });

  it('filters multiple compaction lines in a single output', () => {
    const input = [
      '↓ 200 tokens',
      'Some real content',
      '↓ 400 tokens · thought for 5s',
      'thought for 30s',
    ];
    expect(filterChrome(input)).toEqual(['Some real content']);
  });

  // Regression: on Windows ConPTY, Claude's reply often appears on the
  // line immediately AFTER the user echo with no blank separator, so the
  // user-echo continuation flag was swallowing the reply for the rest
  // of the turn. The fix: a `● ` / `⏺ ` prefix hard-resets the flag.
  it('keeps the Claude reply when it lands right after the user echo (Windows ConPTY layout)', () => {
    const input = [
      '❯ Hola',
      '* Actualizing…',
      '● ¡Hola! ¿En qué puedo ayudarte hoy?',
      '',
      '✻ Crunched for 1s',
      '❯ ',
    ];
    // Echo (`❯ Hola`) and `* Actualizing…` (continuation) and the
    // spinner / empty input prompt all stay filtered; only Claude's
    // reply survives.
    expect(filterChrome(input)).toEqual([
      '● ¡Hola! ¿En qué puedo ayudarte hoy?',
    ]);
  });

  it('also resets continuation on the alternative ⏺ prefix', () => {
    const input = [
      '❯ multi-line',
      'user input continuation that wraps',
      '⏺ Reply from Claude after no blank line',
    ];
    expect(filterChrome(input)).toEqual([
      '⏺ Reply from Claude after no blank line',
    ]);
  });

  it('still filters everything between echo and a blank line on Mac-style layouts', () => {
    const input = [
      '❯ Hola',
      'user input wrap line one',
      'user input wrap line two',
      '',
      '● Hi there',
    ];
    expect(filterChrome(input)).toEqual(['● Hi there']);
  });

});
