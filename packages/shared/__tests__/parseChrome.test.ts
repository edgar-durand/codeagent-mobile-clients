import { describe, it, expect } from 'vitest';
import { isChromeLine, parseChromeLine } from '../src';

describe('isChromeLine', () => {
  it('returns true for spinner-prefixed lines', () => {
    expect(isChromeLine('⠙ Reading src/foo.ts...')).toBe(true);
    expect(isChromeLine('⠋ Editing src/bar.ts')).toBe(true);
    expect(isChromeLine('⠸ Running npm run test')).toBe(true);
    expect(isChromeLine('⠹ Searching for "pattern"')).toBe(true);
  });

  it('returns true for (thinking) lines', () => {
    expect(isChromeLine('(thinking)')).toBe(true);
    expect(isChromeLine('(thinking)  ')).toBe(true);
  });

  it('returns true for separator lines', () => {
    expect(isChromeLine('─────────────────────')).toBe(true);
    expect(isChromeLine('━━━━━━━━━━━━━━━━━━━━━')).toBe(true);
    expect(isChromeLine('───')).toBe(true);
  });

  it('returns true for bare prompt lines', () => {
    expect(isChromeLine('❯ ')).toBe(true);
    expect(isChromeLine('> ')).toBe(true);
  });

  it('returns false for real content lines', () => {
    expect(isChromeLine('Here is the refactored function:')).toBe(false);
    expect(isChromeLine('function filterChrome(lines: string[]): string[] {')).toBe(false);
    expect(isChromeLine('The file has been updated successfully.')).toBe(false);
  });

  it('returns false for empty strings', () => {
    expect(isChromeLine('')).toBe(false);
  });
});

describe('parseChromeLine', () => {
  it('parses Read tool lines', () => {
    const step = parseChromeLine('⠙ Reading src/output.service.ts...');
    expect(step).toEqual({ tool: 'read', label: 'src/output.service.ts', status: 'running' });
  });

  it('parses Edit tool lines', () => {
    const step = parseChromeLine('⠋ Editing src/output.service.ts');
    expect(step).toEqual({ tool: 'edit', label: 'src/output.service.ts', status: 'running' });
  });

  it('parses Bash tool lines', () => {
    const step = parseChromeLine('⠸ Running npm run typecheck');
    expect(step).toEqual({ tool: 'bash', label: 'npm run typecheck', status: 'running' });
  });

  it('parses Search tool lines', () => {
    const step = parseChromeLine('⠹ Searching for "filterChrome"');
    expect(step).toEqual({ tool: 'search', label: '"filterChrome"', status: 'running' });
  });

  it('parses (thinking) lines', () => {
    const step = parseChromeLine('(thinking)');
    expect(step).toEqual({ tool: 'thinking', label: 'Thinking…', status: 'running' });
  });

  it('returns other for unrecognized spinner lines', () => {
    const step = parseChromeLine('⠙ Doing something unknown');
    expect(step).not.toBeNull();
    expect(step!.tool).toBe('other');
    expect(step!.label).toBe('Doing something unknown');
  });

  it('deduplicates spinner lines regardless of time/token format', () => {
    // "(Ns · thinking)" format
    expect(parseChromeLine('⠸ Cultivating… (25s · thinking)')!.label).toBe('Cultivating');
    expect(parseChromeLine('⠸ Cultivating… (26s · thinking)')!.label).toBe('Cultivating');
    // "(Nm Ns · ↓ tokens)" format — 4 minutes 26 seconds
    expect(parseChromeLine('✶ Cultivating… (4m 26s · ↓ 256 tokens)')!.label).toBe('Cultivating');
    // Bare number — partial render "Cultivating… 7"
    expect(parseChromeLine('✶ Cultivating… 7')!.label).toBe('Cultivating');
    expect(parseChromeLine('✶ Cultivating… 8')!.label).toBe('Cultivating');
    // Partial parens — "3 11s · ↓ 256 tokens)" (opening paren missing in PTY frame)
    expect(parseChromeLine('✶ Cultivating… 3 11s · ↓ 256 tokens)')!.label).toBe('Cultivating');
    // All must share the same tool+label dedup key
    const variants = [
      parseChromeLine('✶ Cultivating… (4m 26s · ↓ 256 tokens)'),
      parseChromeLine('✶ Cultivating… 7'),
      parseChromeLine('✶ Cultivating… 3 11s · ↓ 256 tokens)'),
    ];
    for (const v of variants) {
      expect(v).not.toBeNull();
      expect(v!.tool).toBe(variants[0]!.tool);
      expect(v!.label).toBe(variants[0]!.label);
    }
  });

  it('deduplicates + status lines', () => {
    expect(parseChromeLine('+ Bunning… (22s · ↑ 102 tokens)')!.label).toBe('Bunning');
    expect(parseChromeLine('+ Bunning… 7')!.label).toBe('Bunning');
    expect(parseChromeLine('+ Bunning… 3 11s · ↓ 256 tokens)')!.label).toBe('Bunning');
  });

  it('does NOT capture bare "> user typed text" lines as chrome', () => {
    // These are echoed terminal input — should not be chrome steps
    expect(isChromeLine('> no que')).toBe(false);
    expect(isChromeLine('> some text the user typed')).toBe(false);
  });

  it('returns null for separator lines', () => {
    expect(parseChromeLine('─────────────────────')).toBeNull();
    expect(parseChromeLine('━━━━━━━━━━━━━━━━━━━━━')).toBeNull();
  });

  it('returns null for bare prompt lines', () => {
    expect(parseChromeLine('❯ ')).toBeNull();
    expect(parseChromeLine('> ')).toBeNull();
  });
});
