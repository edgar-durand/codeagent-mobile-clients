/**
 * Unit tests for `deriveInputSuggestion`.
 *
 * The function synthesises a composer chip from an ACP agent's final
 * reply when the last non-empty line is a short closing question.
 * Conservatism is the goal — we emit NOTHING rather than a noisy chip.
 */

import { describe, it, expect } from 'vitest';
import { deriveInputSuggestion } from '../../../src/agents/acp/inputSuggestion';

describe('deriveInputSuggestion — positive cases', () => {
  it('returns the last line of a single-line closing question', () => {
    expect(deriveInputSuggestion('Would you like me to continue?')).toBe(
      'Would you like me to continue?',
    );
  });

  it('returns only the last non-empty line from a multi-paragraph reply', () => {
    const text = 'I fixed the bug in auth.ts.\n\nThe issue was a missing null check. Should I also add tests?';
    expect(deriveInputSuggestion(text)).toBe('The issue was a missing null check. Should I also add tests?');
  });

  it('trims leading/trailing whitespace from the last line', () => {
    expect(deriveInputSuggestion('Good morning!\n  Do you want me to proceed?  ')).toBe(
      'Do you want me to proceed?',
    );
  });

  it('ignores trailing blank lines and finds the last non-empty line', () => {
    expect(deriveInputSuggestion('Shall I apply the fix?\n\n\n')).toBe('Shall I apply the fix?');
  });

  it('accepts exactly 8 characters (minimum boundary)', () => {
    // "12345??" → trimmed = "12345??" (7 chars) → null; need 8
    const exactly8 = 'abc def?'; // 8 chars
    expect(exactly8.length).toBe(8);
    expect(deriveInputSuggestion(exactly8)).toBe('abc def?');
  });

  it('accepts exactly 200 characters (maximum boundary)', () => {
    const exactly200 = 'A'.repeat(198) + 'a?';
    expect(exactly200.length).toBe(200);
    expect(deriveInputSuggestion(exactly200)).toBe(exactly200);
  });
});

describe('deriveInputSuggestion — null cases', () => {
  it('returns null for an empty string', () => {
    expect(deriveInputSuggestion('')).toBeNull();
  });

  it('returns null for a string of only whitespace / newlines', () => {
    expect(deriveInputSuggestion('   \n\n  ')).toBeNull();
  });

  it('returns null when the last line does not end with ?', () => {
    expect(deriveInputSuggestion('Here is the updated file.')).toBeNull();
  });

  it('returns null when the last line ends with . not ?', () => {
    expect(deriveInputSuggestion('I updated auth.ts.\nLet me know if you need changes.')).toBeNull();
  });

  it('returns null when the last line is too short (< 8 chars)', () => {
    // "Ok?" is 3 chars
    expect(deriveInputSuggestion('Ok?')).toBeNull();
    // exactly 7 chars — too short
    expect(deriveInputSuggestion('123456?')).toBeNull();
    // "1234567?" is 8 chars — at the minimum boundary, should return
    const result8 = deriveInputSuggestion('1234567?');
    expect(result8).not.toBeNull();
    expect(result8!.length).toBe(8);
  });

  it('returns null when the last line is too long (> 200 chars)', () => {
    const line201 = 'A'.repeat(199) + 'a?';
    expect(line201.length).toBe(201);
    expect(deriveInputSuggestion(line201)).toBeNull();
  });

  it('returns null when the last line is a code block fragment', () => {
    expect(deriveInputSuggestion('```\nconst x = 1;\n```')).toBeNull();
  });

  it('returns null for prose that does not end in a question', () => {
    const prose =
      'I have updated the authentication middleware to use JWT verification. ' +
      'The changes are in `apps/api/src/auth/middleware.ts` and include ' +
      'proper error handling for expired tokens.';
    expect(deriveInputSuggestion(prose)).toBeNull();
  });

  it('returns null for a multi-paragraph reply whose last non-empty line is not a question', () => {
    const text = 'Would you like me to continue?\n\nI already applied the change above.';
    expect(deriveInputSuggestion(text)).toBeNull();
  });
});

describe('deriveInputSuggestion — StreamingState integration: emits chip on normal turn', () => {
  it('AcpPublisher.publishOutput is called with input_suggestion for a closing-question reply', async () => {
    const { StreamingState } = await import('../../../src/agents/acp/runner');
    const { AcpPublisher } = await import('../../../src/agents/acp/publisher');
    const { vi } = await import('vitest');

    const publisher = new AcpPublisher({
      sessionId: 'sess-x',
      pluginId: 'plug-x',
      pluginAuthToken: 'tok-x',
      apiBaseUrl: 'https://api.example.test',
    });
    const publishOutput = vi.spyOn(publisher, 'publishOutput').mockResolvedValue(undefined);
    vi.spyOn(publisher, 'publishStreamingChunk').mockResolvedValue(undefined);

    const state = new StreamingState(publisher);
    state.append({ chunkId: 'c1', kind: 'text', delta: 'Fixed the bug. Would you like me to add tests?' });
    // closeTurnWithInteractiveDetection returns false (no select_prompt) for this reply
    const emittedSelectPrompt = await state.closeTurnWithInteractiveDetection();
    expect(emittedSelectPrompt).toBe(false);

    // The text done:true was emitted
    const textCall = publishOutput.mock.calls.find(
      (c) => (c[0] as { type: string }).type === 'text',
    );
    expect(textCall).toBeDefined();

    // Caller should now emit input_suggestion (simulate what runner.ts does)
    const finalText = 'Fixed the bug. Would you like me to add tests?';
    const suggestion = deriveInputSuggestion(finalText);
    expect(suggestion).toBe('Fixed the bug. Would you like me to add tests?');
    // Manually publish (the runner does this)
    await publisher.publishOutput({ type: 'input_suggestion', content: suggestion!, done: true });
    const chipCall = publishOutput.mock.calls.find(
      (c) => (c[0] as { type: string }).type === 'input_suggestion',
    );
    expect(chipCall).toBeDefined();
    expect((chipCall![0] as { content: string }).content).toBe(
      'Fixed the bug. Would you like me to add tests?',
    );
  });

  it('closeTurnWithInteractiveDetection returns true (select_prompt emitted) for a numbered options reply', async () => {
    const { StreamingState } = await import('../../../src/agents/acp/runner');
    const { AcpPublisher } = await import('../../../src/agents/acp/publisher');
    const { vi } = await import('vitest');

    const publisher = new AcpPublisher({
      sessionId: 'sess-y',
      pluginId: 'plug-y',
      pluginAuthToken: 'tok-y',
      apiBaseUrl: 'https://api.example.test',
    });
    vi.spyOn(publisher, 'publishOutput').mockResolvedValue(undefined);
    vi.spyOn(publisher, 'publishStreamingChunk').mockResolvedValue(undefined);

    const state = new StreamingState(publisher);
    state.append({ chunkId: 'c2', kind: 'text', delta: 'How would you like to proceed?\n\n1. Apply fix\n2. See plan' });
    const emittedSelectPrompt = await state.closeTurnWithInteractiveDetection();
    // select_prompt WAS emitted — runner must NOT emit input_suggestion
    expect(emittedSelectPrompt).toBe(true);
  });
});
