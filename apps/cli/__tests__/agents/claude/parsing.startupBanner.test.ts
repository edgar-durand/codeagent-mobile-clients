import { describe, it, expect } from 'vitest';
import { detectStartupBanner } from '../../../src/agents/claude/parsing';

describe('detectStartupBanner', () => {
  it('detects the legacy 3-line block-art banner', () => {
    const lines = [
      '▐▛███▜▌ Welcome to Claude Code',
      '▝▜███▛▘ Sonnet 4.6 · Claude Pro',
      '▘▘  ▝▝ /Users/edgar/Documents/codeagent',
      '',
      '? for shortcuts',
    ];
    const result = detectStartupBanner(lines);
    expect(result).not.toBeNull();
    expect(result?.title).toBe('Welcome to Claude Code');
    expect(result?.subtitle).toBe('Sonnet 4.6 · Claude Pro');
    expect(result?.path).toBe('/Users/edgar/Documents/codeagent');
    expect(result?.startIdx).toBe(0);
    expect(result?.endIdx).toBe(2);
  });

  it('detects the v2.x multi-row banner with separate metadata + path', () => {
    const lines = [
      '▰▰▰▰▰  ▰▰▰  ▰▰▰▰  ▰▰▰▰',
      '▰        ▰    ▰▰  ▰   ▰',
      '▰▰▰▰▰  ▰▰▰  ▰  ▰▰  ▰▰▰▰',
      'Sonnet 4.6 · Claude API',
      '/Users/edgar/projects/my-app',
      '',
      '? for shortcuts',
    ];
    const result = detectStartupBanner(lines);
    expect(result).not.toBeNull();
    expect(result?.title).toBe('');
    expect(result?.subtitle).toBe('Sonnet 4.6 · Claude API');
    expect(result?.path).toBe('/Users/edgar/projects/my-app');
    expect(result?.startIdx).toBe(0);
    expect(result?.endIdx).toBe(4);
  });

  it('returns null when fewer than 2 contiguous art rows precede the metadata', () => {
    const lines = [
      'random text without art',
      '▰ single isolated glyph',
      'Sonnet 4.6 · Claude API',
      '/tmp',
    ];
    expect(detectStartupBanner(lines)).toBeNull();
  });

  it('returns null when there is no banner at all', () => {
    const lines = [
      'Hello, how can I help today?',
      '',
      '? for shortcuts',
    ];
    expect(detectStartupBanner(lines)).toBeNull();
  });

  it('omits the path when the line after the metadata is itself art', () => {
    const lines = [
      '▰▰▰▰▰  ▰▰▰',
      '▰        ▰  ',
      'Sonnet 4.6 · Claude API',
      '▰ trailing art',
    ];
    const result = detectStartupBanner(lines);
    expect(result).not.toBeNull();
    expect(result?.path).toBe('');
    expect(result?.endIdx).toBe(2);
  });
});
