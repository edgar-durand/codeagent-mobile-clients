import { describe, it, expect } from 'vitest';
import {
  AGENT_STANDARD_TEXT,
  AGENT_STANDARD_BLOCK,
  AGENT_STANDARD_MARKER,
} from '../src/skills/agent-standard';

describe('AGENT_STANDARD', () => {
  it('is non-empty and states the working standard', () => {
    expect(AGENT_STANDARD_TEXT).toContain('# Working standard');
    expect(AGENT_STANDARD_TEXT).toContain('Stay in scope');
    expect(AGENT_STANDARD_TEXT).toContain('Never expose or exfiltrate');
    expect(AGENT_STANDARD_TEXT.length).toBeGreaterThan(400);
  });

  it('is repo-agnostic — no CodeAgent-internal workflow leaks into the user-facing standard', () => {
    const lower = AGENT_STANDARD_TEXT.toLowerCase();
    for (const term of ['beads', 'prisma', 'gcloud', 'vercel', 'eas update', 'cloud run', 'dev→pr']) {
      expect(lower).not.toContain(term);
    }
  });

  it('wraps the text in the idempotency marker on both ends', () => {
    expect(AGENT_STANDARD_BLOCK.startsWith(AGENT_STANDARD_MARKER)).toBe(true);
    expect(AGENT_STANDARD_BLOCK.endsWith(AGENT_STANDARD_MARKER)).toBe(true);
    expect(AGENT_STANDARD_BLOCK).toContain(AGENT_STANDARD_TEXT);
  });
});
