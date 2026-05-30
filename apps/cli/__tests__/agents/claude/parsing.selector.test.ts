import { describe, test, expect } from 'vitest';
import { detectSelector } from '../../../src/agents/claude/parsing';

/**
 * Regression coverage for the wrapped-label bug — Claude's Bash
 * confirmation prompt where option 2 embeds a long command that
 * wraps over multiple lines. The TUI renders the second option
 * without a space after the dot (`2.Yes,...`), which the old
 * `\d+\.\s+` regex rejected — the line then fell into the
 * continuation branch and option 3 ("No") got promoted to option 2
 * on the mobile renderer. Mobile users saw only 2 options instead
 * of 3, with option 1's description leaking the option-2 payload.
 */
describe('detectSelector — wrapped option labels', () => {
  test('matches `<n>.Label` (no space after the dot)', () => {
    const lines = [
      'Bash command',
      '',
      "  grep -n \"pattern\" file.tsx",
      '',
      'Do you want to proceed?',
      '❯ 1. Yes',
      "  2.Yes, and don't ask again: grep -n \"pattern\"",
      '    for                       file.tsx',
      '  3. No',
      '',
      'Esc to cancel · Tab to amend · ctrl+e to explain',
    ];
    const result = detectSelector(lines);
    expect(result).not.toBeNull();
    expect(result?.options).toEqual([
      'Yes',
      "Yes, and don't ask again: grep -n \"pattern\"",
      'No',
    ]);
    // Wrapped continuation should land in option 2's description.
    expect(result?.optionDescriptions?.[1]).toContain('for');
    expect(result?.optionDescriptions?.[1]).toContain('file.tsx');
  });

  test('still matches the standard `<n>. Label` form', () => {
    const lines = [
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No',
    ];
    const result = detectSelector(lines);
    expect(result?.options).toEqual(['Yes', 'No']);
  });

  test('does not misread a decimal like `2.5` as an option', () => {
    const lines = [
      '❯ 1. Apply 2.5x speed',
      '  2. Cancel',
    ];
    const result = detectSelector(lines);
    expect(result?.options).toEqual(['Apply 2.5x speed', 'Cancel']);
  });
});
