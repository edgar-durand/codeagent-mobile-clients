import { describe, test, expect } from 'vitest';
import { detectInputSuggestion } from '../../../src/agents/claude/parsing';

/**
 * Claude Code shows a ghost-text completion in the `> ` input area
 * after a turn settles. Mobile surfaces it as a quick-reply chip
 * above the composer so the user can accept the suggestion in one
 * tap. This module owns the detection contract.
 */
describe('detectInputSuggestion', () => {
  test('returns the suggested text when the idle hint is visible', () => {
    const lines = [
      '* Worked for 11s',
      '',
      '> Yes, replica el del webapp',
      '? for shortcuts · ← for agents',
    ];
    expect(detectInputSuggestion(lines)).toBe('Yes, replica el del webapp');
  });

  test('returns null when no idle hint is visible (agent still working)', () => {
    const lines = [
      '> Yes, replica el del webapp',
      '✳ Cooking…',
    ];
    expect(detectInputSuggestion(lines)).toBeNull();
  });

  test('returns null when a numbered selector owns the screen', () => {
    const lines = [
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No',
      '? for shortcuts · ← for agents',
    ];
    expect(detectInputSuggestion(lines)).toBeNull();
  });

  test('returns null when the input area is empty', () => {
    const lines = [
      '* Worked for 3s',
      '>',
      '? for shortcuts · ← for agents',
    ];
    expect(detectInputSuggestion(lines)).toBeNull();
  });

  test('also accepts the `❯` cursor variant', () => {
    const lines = [
      '❯ replicate the webapp',
      '? for shortcuts · ← for agents',
    ];
    expect(detectInputSuggestion(lines)).toBe('replicate the webapp');
  });

  test('does not pick up the navigation hint as a suggestion', () => {
    // Some TUI states emit `> for agents` style lines as part of
    // the help row; the detector skips them by the leading `for `
    // guard.
    const lines = [
      '> for agents',
      '? for shortcuts · ← for agents',
    ];
    expect(detectInputSuggestion(lines)).toBeNull();
  });
});
