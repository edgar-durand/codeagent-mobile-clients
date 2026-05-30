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

  test('ignores historical user echoes from scrollback', () => {
    // A previous turn's `> Hola` echo lives high up in the rendered
    // window but Claude has since responded and is now at an empty
    // input prompt. The detector must ONLY look at the lines
    // immediately above `? for shortcuts` — otherwise the chip
    // shows stale historical text forever.
    const lines = [
      '> Hola',
      '',
      '● Hola Edgar 👋 ¿En qué te puedo ayudar hoy?',
      '',
      '',
      '* Brewed for 9s',
      '',
      '>',
      '? for shortcuts · ← for agents',
    ];
    expect(detectInputSuggestion(lines)).toBeNull();
  });

  test('detects a live suggestion right above the hint', () => {
    const lines = [
      '> Hola',
      '',
      '● Hola Edgar 👋',
      '',
      '> Yes, replica el del webapp',
      '? for shortcuts · ← for agents',
    ];
    expect(detectInputSuggestion(lines)).toBe('Yes, replica el del webapp');
  });

  // Modern Claude TUI wraps the input area in a box-drawing rectangle:
  //
  //   ──────────────────────────────────────────────
  //   ❯ Cerrar el ciclo de push notifications
  //   ──────────────────────────────────────────────
  //     ? for shortcuts · ← for agents
  //
  // The walker must skip the `─` border lines and look INSIDE the box
  // rather than aborting on the first non-`>`-prefixed line.
  test('detects a suggestion wrapped in a box-drawn input rectangle', () => {
    const lines = [
      '✻ Cooked for 13s',
      '',
      '──────────────────────────────────────────────',
      '❯ Cerrar el ciclo de push notifications',
      '──────────────────────────────────────────────',
      '  ? for shortcuts · ← for agents',
    ];
    expect(detectInputSuggestion(lines)).toBe('Cerrar el ciclo de push notifications');
  });

  test('returns null when the box-drawn input is empty', () => {
    const lines = [
      '──────────────────────────────────────────────',
      '❯',
      '──────────────────────────────────────────────',
      '  ? for shortcuts · ← for agents',
    ];
    expect(detectInputSuggestion(lines)).toBeNull();
  });
});
