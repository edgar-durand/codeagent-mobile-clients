import { describe, expect, it } from 'vitest';
import { PREVIEW_DETECT_PROMPT } from './preview-prompts';

describe('PREVIEW_DETECT_PROMPT', () => {
  it('mentions all required JSON fields', () => {
    for (const field of ['framework', 'command', 'args', 'port', 'ready_pattern']) {
      expect(PREVIEW_DETECT_PROMPT).toContain(`"${field}"`);
    }
  });

  it('mentions the Expo special case', () => {
    // The Expo guidance is rendered as a JSON args literal in the
    // prompt body (`args=["expo","start","--tunnel"]`), not the
    // shell-quoted form.
    expect(PREVIEW_DETECT_PROMPT).toContain('"expo","start","--tunnel"');
    expect(PREVIEW_DETECT_PROMPT).toContain('Expo Go');
  });

  it('instructs JSON-only output', () => {
    expect(PREVIEW_DETECT_PROMPT).toContain('OUTPUT JSON ONLY');
  });
});
