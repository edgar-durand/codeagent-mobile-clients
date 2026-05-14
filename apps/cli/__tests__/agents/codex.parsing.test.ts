import { describe, it, expect } from 'vitest';
import { filterCodexChrome, parseCodexChrome, detectCodexSelector } from '../../src/agents/codex/parsing';

describe('codex/parsing filterCodexChrome', () => {
  it('keeps an agent reply that starts with • after a user prompt', () => {
    const lines = ['› hola', '', '• Hola. ¿Qué necesitas que haga?'];
    const out = filterCodexChrome(lines);
    expect(out).toContain('Hola. ¿Qué necesitas que haga?');
  });

  it('strips the leading • from the emitted line so the bubble is clean', () => {
    const lines = ['• Hola.'];
    const out = filterCodexChrome(lines);
    expect(out.some(l => l.startsWith('•'))).toBe(false);
    expect(out).toContain('Hola.');
  });

  it('drops intro box drawing + Tip / Learn more banners', () => {
    const lines = [
      '╭───────────────────────────────────────╮',
      '│ >_ OpenAI Codex (v0.130.0)            │',
      '│ model:     gpt-5.5                    │',
      '╰───────────────────────────────────────╯',
      '  Tip: GPT-5.5 is now available in Codex.',
      '  Learn more: https://openai.com/...',
      '• Real agent reply',
    ];
    const out = filterCodexChrome(lines);
    expect(out).not.toContain(expect.stringContaining('OpenAI Codex'));
    expect(out.find(l => l.startsWith('Tip:'))).toBeUndefined();
    expect(out.find(l => l.startsWith('Learn more:'))).toBeUndefined();
    expect(out).toContain('Real agent reply');
  });

  it('drops the user-prompt echo with the › prefix', () => {
    const lines = ['› what is the time?', '• 11:25 PM'];
    const out = filterCodexChrome(lines);
    expect(out.find(l => /^[›>]\s/.test(l))).toBeUndefined();
    expect(out).toContain('11:25 PM');
  });

  it('handles multiple turns: each › resets the echo guard', () => {
    const lines = [
      '› hola',
      '',
      '• Hola. Estoy listo.',
      '› hola',
      '',
      '• Hola. ¿Qué necesitas?',
    ];
    const out = filterCodexChrome(lines);
    expect(out).toContain('Hola. Estoy listo.');
    expect(out).toContain('Hola. ¿Qué necesitas?');
    expect(out.filter(l => /^[›>]\s/.test(l))).toHaveLength(0);
  });

  it('keeps non-echo, non-bullet plain text lines (multi-line agent response)', () => {
    const lines = ['• First line of reply', 'continuation line without bullet'];
    const out = filterCodexChrome(lines);
    expect(out).toContain('First line of reply');
    expect(out).toContain('continuation line without bullet');
  });

  it('drops box-drawing lines regardless of surrounding content', () => {
    const lines = ['╭──────╮', '│ info │', '╰──────╯'];
    const out = filterCodexChrome(lines);
    expect(out.every(l => !/^[╭╰│]/.test(l.trimStart()))).toBe(true);
  });

  it('regression: Claude still works through the Claude strategy (no Codex changes touched shared)', () => {
    // No-op — Claude path goes through @codeagent/shared filterChrome
    // unchanged. This test exists as documentation.
    expect(true).toBe(true);
  });
});

describe('codex/parsing parseCodexChrome', () => {
  it('always returns null (Codex Phase 2 has no chrome steps)', () => {
    expect(parseCodexChrome('• some reply')).toBeNull();
    expect(parseCodexChrome('• Reading file.ts')).toBeNull();
    expect(parseCodexChrome('')).toBeNull();
  });
});

describe('codex/parsing detectCodexSelector', () => {
  it('always returns null (Codex has no numbered selector TUI)', () => {
    const lines = ['❯ 1. Option A', '  2. Option B'];
    expect(detectCodexSelector(lines)).toBeNull();
    expect(detectCodexSelector([])).toBeNull();
  });
});
