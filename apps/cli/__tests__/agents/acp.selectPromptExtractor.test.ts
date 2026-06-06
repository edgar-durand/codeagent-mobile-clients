/**
 * Conservative-heuristics suite for the select-prompt extractor.
 *
 * The bias is "miss a borderline case before mis-detecting prose as
 * an interactive prompt" — the failure mode of false-positives
 * (chat turns into a button maze) is worse than false-negatives
 * (an agent question shows as plain text).
 */

import { describe, expect, it } from 'vitest';
import { extractSelectPrompt } from '../../src/agents/acp/selectPromptExtractor';

describe('extractSelectPrompt — positive cases', () => {
  it('detects a standard question + 3 numbered options', () => {
    const text = 'Te he analizado el repo.\n\n¿Cómo prefieres proceder?\n\n1. Aplicar refactor\n2. Ver plan\n3. Cancelar';
    const r = extractSelectPrompt(text);
    expect(r).not.toBeNull();
    expect(r!.options).toEqual(['Aplicar refactor', 'Ver plan', 'Cancelar']);
    expect(r!.question).toBe('¿Cómo prefieres proceder');
    expect(r!.textBefore).toBe('Te he analizado el repo.');
  });

  it('detects question ending in colon (not just ?)', () => {
    const r = extractSelectPrompt('Selecciona una opción:\n\n1. uno\n2. dos');
    expect(r).not.toBeNull();
    expect(r!.question).toBe('Selecciona una opción');
    expect(r!.options).toEqual(['uno', 'dos']);
  });

  it('detects 2 options (minimum)', () => {
    const r = extractSelectPrompt('1. yes\n2. no');
    expect(r).not.toBeNull();
    expect(r!.options).toEqual(['yes', 'no']);
    expect(r!.question).toBeNull();
  });

  it('detects 6 options (maximum)', () => {
    const text = Array.from({ length: 6 }, (_, n) => `${n + 1}. opt ${n + 1}`).join('\n');
    const r = extractSelectPrompt(text);
    expect(r).not.toBeNull();
    expect(r!.options).toHaveLength(6);
  });

  it('accepts parenthesis-style numbering 1)', () => {
    const r = extractSelectPrompt('Pick?\n\n1) alpha\n2) bravo');
    expect(r).not.toBeNull();
    expect(r!.options).toEqual(['alpha', 'bravo']);
  });

  it('accepts bracket-style numbering 1]', () => {
    const r = extractSelectPrompt('Pick?\n\n1] alpha\n2] bravo');
    expect(r).not.toBeNull();
    expect(r!.options).toEqual(['alpha', 'bravo']);
  });

  it('tolerates non-1 starting number when sequential (Codex zero-indexed)', () => {
    const r = extractSelectPrompt('Pick?\n\n0. zero\n1. one\n2. two');
    expect(r).not.toBeNull();
    expect(r!.options).toEqual(['zero', 'one', 'two']);
  });

  it('strips trailing blank lines before detection', () => {
    const r = extractSelectPrompt('Pick?\n\n1. a\n2. b\n\n\n');
    expect(r).not.toBeNull();
    expect(r!.options).toEqual(['a', 'b']);
  });

  it('handles emoji/markdown formatting in option bodies', () => {
    const r = extractSelectPrompt('Opciones:\n\n1. 🔧 **Aplicar** refactor\n2. 📝 Ver plan\n3. ❌ Cancelar');
    expect(r).not.toBeNull();
    expect(r!.options[0]).toBe('🔧 **Aplicar** refactor');
  });
});

describe('extractSelectPrompt — negative cases (must NOT match)', () => {
  it('returns null for empty text', () => {
    expect(extractSelectPrompt('')).toBeNull();
  });

  it('returns null for plain prose with no numbered list', () => {
    expect(extractSelectPrompt('Hola, esto es solo texto plano sin opciones.')).toBeNull();
  });

  it('returns null for a single numbered item (not a real selector)', () => {
    expect(extractSelectPrompt('Sí\n\n1. just this')).toBeNull();
  });

  it('returns null for non-sequential numbering', () => {
    expect(extractSelectPrompt('Pick?\n\n1. one\n4. four\n7. seven')).toBeNull();
  });

  it('returns null when the numbered run is followed by more prose', () => {
    const text = 'Pick?\n\n1. a\n2. b\n\nAdditional context: this is documentation about why.';
    expect(extractSelectPrompt(text)).toBeNull();
  });

  it('returns null when too many options (UX button-maze guard)', () => {
    const text = Array.from({ length: 10 }, (_, n) => `${n + 1}. opt`).join('\n');
    expect(extractSelectPrompt(text)).toBeNull();
  });

  it('returns null when an option body is too long (likely prose paragraph)', () => {
    const longBody = 'x'.repeat(250);
    const text = `Pick?\n\n1. ${longBody}\n2. short`;
    expect(extractSelectPrompt(text)).toBeNull();
  });

  it('returns null when an option body is empty', () => {
    expect(extractSelectPrompt('Pick?\n\n1. \n2. valid')).toBeNull();
  });
});

describe('extractSelectPrompt — textBefore + question slicing', () => {
  it('puts prose before the question in textBefore', () => {
    const text = 'Reporte:\nTodo bien.\n\n¿Continuar?\n\n1. sí\n2. no';
    const r = extractSelectPrompt(text)!;
    expect(r.textBefore).toBe('Reporte:\nTodo bien.');
    expect(r.question).toBe('¿Continuar');
  });

  it('returns empty textBefore when prompt is the entire text', () => {
    const r = extractSelectPrompt('¿Cuál?\n\n1. a\n2. b')!;
    expect(r.textBefore).toBe('');
    expect(r.question).toBe('¿Cuál');
  });

  it('returns empty question when no ? or : ending line precedes the options', () => {
    const r = extractSelectPrompt('Aquí están las opciones\n\n1. a\n2. b')!;
    expect(r.question).toBeNull();
    // The non-question prose stays in textBefore.
    expect(r.textBefore).toBe('Aquí están las opciones');
  });
});
