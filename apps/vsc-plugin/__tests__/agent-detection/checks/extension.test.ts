import { describe, test, expect } from 'vitest';
import { findExtension } from '../../../src/services/agent-detection/checks/extension';
import type { Extension } from 'vscode';

function ext(id: string): Extension<unknown> {
  return { id } as unknown as Extension<unknown>;
}

describe('findExtension', () => {
  test('returns the first id that matches exactly', () => {
    const list = [ext('GitHub.copilot'), ext('anthropic.claude-code')];
    expect(findExtension(['anthropic.claude-code'], list)?.id).toBe('anthropic.claude-code');
  });

  test('matches case-insensitively (Copilot is published with capital G)', () => {
    const list = [ext('GitHub.copilot')];
    expect(findExtension(['github.copilot'], list)?.id).toBe('GitHub.copilot');
  });

  test('returns the first candidate in the list that matches', () => {
    const list = [ext('anthropics.claude')];
    expect(findExtension(['anthropic.claude-code', 'anthropics.claude'], list)?.id).toBe(
      'anthropics.claude',
    );
  });

  test('returns undefined when no candidate matches', () => {
    expect(findExtension(['foo.bar'], [ext('baz.qux')])).toBeUndefined();
  });
});
