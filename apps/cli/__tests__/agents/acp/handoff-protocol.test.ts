/**
 * Unit tests for the `codeam-handoff` fence protocol — extraction/validation
 * of an agent-proposed handoff from a reply's tail, and the partial-fence
 * start detector the streaming layer uses to truncate live output before the
 * fence body exists.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/services/logger', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

import {
  extractHandoffProposal,
  handoffFenceStart,
} from '../../../src/agents/acp/handoff-protocol';
import { log } from '../../../src/services/logger';

const TARGETS = new Set(['codex', 'gemini']);

// ─── extractHandoffProposal — happy path ────────────────────────────────────

describe('extractHandoffProposal — happy path', () => {
  it('extracts and strips a valid proposal at the end of the text', () => {
    const text =
      'Done with the tests.\n\n```codeam-handoff\n{"to":"codex","reason":"tests fixed, needs review","prompt":"Review the diff in src/"}\n```\n';
    const r = extractHandoffProposal(text, 'claude', TARGETS);
    expect(r.proposal).toEqual({
      to: 'codex',
      reason: 'tests fixed, needs review',
      prompt: 'Review the diff in src/',
    });
    expect(r.cleanText).toBe('Done with the tests.');
    expect(r.cleanText).not.toContain('codeam-handoff');
  });

  it('strips a fence in the middle of the text and joins the surrounding text', () => {
    const text =
      'Before the fence.\n\n```codeam-handoff\n{"to":"gemini","reason":"big log analysis","prompt":"Summarize logs/"}\n```\n\nAfter the fence.';
    const r = extractHandoffProposal(text, 'claude', TARGETS);
    expect(r.proposal).toEqual({
      to: 'gemini',
      reason: 'big log analysis',
      prompt: 'Summarize logs/',
    });
    expect(r.cleanText).not.toContain('codeam-handoff');
    expect(r.cleanText).toContain('Before the fence.');
    expect(r.cleanText).toContain('After the fence.');
    // No dangling blank-line runs left behind by the removed fence.
    expect(r.cleanText).not.toMatch(/\n{3,}/);
  });
});

// ─── extractHandoffProposal — invalid proposals still strip the fence ──────

describe('extractHandoffProposal — invalid proposals', () => {
  it('malformed JSON → stripped + null', () => {
    const text = 'Reply text.\n\n```codeam-handoff\n{not valid json\n```\n';
    const r = extractHandoffProposal(text, 'claude', TARGETS);
    expect(r.proposal).toBeNull();
    expect(r.cleanText).toBe('Reply text.');
    expect(r.cleanText).not.toContain('codeam-handoff');
  });

  it('unknown target → stripped + null', () => {
    const text =
      'Reply text.\n\n```codeam-handoff\n{"to":"not-a-real-agent","reason":"x","prompt":"y"}\n```\n';
    const r = extractHandoffProposal(text, 'claude', TARGETS);
    expect(r.proposal).toBeNull();
    expect(r.cleanText).toBe('Reply text.');
  });

  it('to === currentAgent → null (still stripped)', () => {
    const text =
      'Reply text.\n\n```codeam-handoff\n{"to":"claude","reason":"x","prompt":"y"}\n```\n';
    const r = extractHandoffProposal(text, 'claude', TARGETS);
    expect(r.proposal).toBeNull();
    expect(r.cleanText).toBe('Reply text.');
  });

  it('empty reason → stripped + null', () => {
    const text = 'Reply text.\n\n```codeam-handoff\n{"to":"codex","reason":"","prompt":"y"}\n```\n';
    const r = extractHandoffProposal(text, 'claude', TARGETS);
    expect(r.proposal).toBeNull();
    expect(r.cleanText).toBe('Reply text.');
  });

  it('empty prompt → stripped + null', () => {
    const text = 'Reply text.\n\n```codeam-handoff\n{"to":"codex","reason":"x","prompt":""}\n```\n';
    const r = extractHandoffProposal(text, 'claude', TARGETS);
    expect(r.proposal).toBeNull();
    expect(r.cleanText).toBe('Reply text.');
  });

  it('reason over 1000 chars → stripped + null (mirrors backend cap)', () => {
    const longReason = 'a'.repeat(1001);
    const text = `Reply text.\n\n\`\`\`codeam-handoff\n${JSON.stringify({ to: 'codex', reason: longReason, prompt: 'y' })}\n\`\`\`\n`;
    const r = extractHandoffProposal(text, 'claude', TARGETS);
    expect(r.proposal).toBeNull();
    expect(r.cleanText).toBe('Reply text.');
  });

  it('prompt over 8000 chars → stripped + null (mirrors backend cap)', () => {
    const longPrompt = 'a'.repeat(8001);
    const text = `Reply text.\n\n\`\`\`codeam-handoff\n${JSON.stringify({ to: 'codex', reason: 'x', prompt: longPrompt })}\n\`\`\`\n`;
    const r = extractHandoffProposal(text, 'claude', TARGETS);
    expect(r.proposal).toBeNull();
    expect(r.cleanText).toBe('Reply text.');
  });

  it('reason at exactly 1000 chars and prompt at exactly 8000 chars → valid', () => {
    const reason = 'a'.repeat(1000);
    const prompt = 'b'.repeat(8000);
    const text = `Reply text.\n\n\`\`\`codeam-handoff\n${JSON.stringify({ to: 'codex', reason, prompt })}\n\`\`\`\n`;
    const r = extractHandoffProposal(text, 'claude', TARGETS);
    expect(r.proposal).toEqual({ to: 'codex', reason, prompt });
  });

  it('logs dropped/invalid proposals via the shared log util, never console', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const text = 'Reply text.\n\n```codeam-handoff\n{not valid json\n```\n';
    extractHandoffProposal(text, 'claude', TARGETS);
    expect(log.debug).toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ─── extractHandoffProposal — multiple fences ───────────────────────────────

describe('extractHandoffProposal — multiple fences', () => {
  it('only the LAST fence is considered for the proposal; both are stripped', () => {
    const text = [
      'First attempt.',
      '',
      '```codeam-handoff',
      '{"to":"codex","reason":"first","prompt":"first prompt"}',
      '```',
      '',
      'Second attempt.',
      '',
      '```codeam-handoff',
      '{"to":"gemini","reason":"second","prompt":"second prompt"}',
      '```',
      '',
    ].join('\n');
    const r = extractHandoffProposal(text, 'claude', TARGETS);
    expect(r.proposal).toEqual({ to: 'gemini', reason: 'second', prompt: 'second prompt' });
    expect(r.cleanText).not.toContain('codeam-handoff');
    expect(r.cleanText).toContain('First attempt.');
    expect(r.cleanText).toContain('Second attempt.');
    expect(r.cleanText).not.toMatch(/\n{3,}/);
  });
});

// ─── extractHandoffProposal — no fence ──────────────────────────────────────

describe('extractHandoffProposal — no fence', () => {
  it('leaves text unchanged when there is no fence', () => {
    const text = 'Just a normal reply with no handoff.';
    const r = extractHandoffProposal(text, 'claude', TARGETS);
    expect(r.proposal).toBeNull();
    expect(r.cleanText).toBe(text);
  });
});

// ─── handoffFenceStart ───────────────────────────────────────────────────────

describe('handoffFenceStart', () => {
  it('returns -1 when there is no fence', () => {
    expect(handoffFenceStart('nothing to see here')).toBe(-1);
  });

  it('detects a fully-formed fence', () => {
    const text = 'Reply.\n\n```codeam-handoff\n{"to":"codex"}\n```\n';
    const idx = handoffFenceStart(text);
    expect(idx).toBe(text.indexOf('```codeam-handoff'));
    expect(idx).toBeGreaterThan(-1);
  });

  it('detects a partial fence opening before the body/close exist', () => {
    const text = 'Reply so far...\n\n```codeam-handoff\n{"to": ';
    const idx = handoffFenceStart(text);
    expect(idx).toBe(text.indexOf('```codeam-handoff'));
    expect(idx).toBeGreaterThan(-1);
  });
});
