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
  handoffFenceStartMasked,
  resolveHandoffTarget,
  stripHandoffFences,
} from '../../../src/agents/acp/handoff-protocol';
import { log } from '../../../src/services/logger';
import { HANDOFF_FENCE_TAG } from '@codeam/shared';

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

// ─── extractHandoffProposal — quoted example inside a 4+-backtick block ────

describe('extractHandoffProposal — quoted example inside a 4+-backtick block', () => {
  it('a codeam-handoff fence nested inside a ````-fenced example is left untouched, no proposal', () => {
    const text = [
      "Here's how the handoff protocol works, for reference:",
      '',
      '````',
      'To hand off, end your reply with:',
      '```codeam-handoff',
      '{"to":"codex","reason":"example only","prompt":"do not run this"}',
      '```',
      '````',
      '',
    ].join('\n');
    const r = extractHandoffProposal(text, 'claude', TARGETS);
    expect(r.proposal).toBeNull();
    expect(r.cleanText).toBe(text);
  });

  it('a real top-level fence AFTER a quoted example: example preserved, real fence stripped + proposal returned', () => {
    const text = [
      "Here's how the handoff protocol works, for reference:",
      '',
      '````',
      'To hand off, end your reply with:',
      '```codeam-handoff',
      '{"to":"codex","reason":"example only","prompt":"do not run this"}',
      '```',
      '````',
      '',
      'Given that, I am handing off now.',
      '',
      '```codeam-handoff',
      '{"to":"gemini","reason":"real handoff","prompt":"do the real thing"}',
      '```',
      '',
    ].join('\n');
    const r = extractHandoffProposal(text, 'claude', TARGETS);
    expect(r.proposal).toEqual({
      to: 'gemini',
      reason: 'real handoff',
      prompt: 'do the real thing',
    });
    // The quoted example survives verbatim, including its nested fence text.
    expect(r.cleanText).toContain('````');
    expect(r.cleanText).toContain(
      '{"to":"codex","reason":"example only","prompt":"do not run this"}',
    );
    expect(r.cleanText).toContain('Given that, I am handing off now.');
    // Only the REAL top-level fence's JSON is gone from the tail.
    expect(r.cleanText).not.toContain('do the real thing');
    expect(r.cleanText).not.toMatch(/\n{3,}/);
  });
});

// ─── extractHandoffProposal — CRLF ──────────────────────────────────────────

describe('extractHandoffProposal — CRLF', () => {
  it('collapses a CRLF blank-line run left at the seam to at most one blank line', () => {
    const text =
      'Before the fence.\r\n\r\n```codeam-handoff\r\n{"to":"codex","reason":"x","prompt":"y"}\r\n```\r\n\r\nAfter the fence.';
    const r = extractHandoffProposal(text, 'claude', TARGETS);
    expect(r.proposal).toEqual({ to: 'codex', reason: 'x', prompt: 'y' });
    expect(r.cleanText).not.toContain('codeam-handoff');
    expect(r.cleanText).toContain('Before the fence.');
    expect(r.cleanText).toContain('After the fence.');
    expect(r.cleanText).not.toMatch(/(?:\r?\n){3,}/);
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

// ─── stripHandoffFences — fence-less passthrough ─────────────────────────────

describe('stripHandoffFences — no fence', () => {
  it('is a byte-identical passthrough (no trim, no blank-line collapse)', () => {
    const text = '  \nParagraph one.\n\n\n\nParagraph two after a big gap.\n\n  ';
    expect(stripHandoffFences(text)).toBe(text);
  });

  it('still strips a real fence and collapses only then', () => {
    const text =
      'Before.\n\n```codeam-handoff\n{"to":"codex","reason":"r","prompt":"p"}\n```\n\nAfter.';
    const out = stripHandoffFences(text);
    expect(out).not.toContain('codeam-handoff');
    expect(out).toContain('Before.');
    expect(out).toContain('After.');
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

// ─── handoffFenceStartMasked ─────────────────────────────────────────────────

describe('handoffFenceStartMasked', () => {
  it('returns -1 when there is no fence', () => {
    expect(handoffFenceStartMasked('nothing to see here')).toBe(-1);
  });

  it('detects a fully-formed real fence (no outer quoting) at the same index as handoffFenceStart', () => {
    const text = 'Reply.\n\n```codeam-handoff\n{"to":"codex"}\n```\n';
    const idx = handoffFenceStartMasked(text);
    expect(idx).toBe(text.indexOf('```codeam-handoff'));
    expect(idx).toBeGreaterThan(-1);
  });

  it('detects a partial fence opening before the body/close exist (still real, no outer quoting)', () => {
    const text = 'Reply so far...\n\n```codeam-handoff\n{"to": ';
    const idx = handoffFenceStartMasked(text);
    expect(idx).toBe(text.indexOf('```codeam-handoff'));
    expect(idx).toBeGreaterThan(-1);
  });

  it('a codeam-handoff fence quoted inside a closed 4+-backtick example → -1 (example only)', () => {
    const text = [
      "Here's how the handoff protocol works, for reference:",
      '',
      '````',
      'To hand off, end your reply with:',
      '```' + HANDOFF_FENCE_TAG,
      '{"to":"codex","reason":"example only","prompt":"do not run this"}',
      '```',
      '````',
      '',
    ].join('\n');
    expect(handoffFenceStartMasked(text)).toBe(-1);
  });

  it('a real top-level fence AFTER a quoted example: returns the REAL fence raw index, not the quoted one', () => {
    const text = [
      "Here's how the handoff protocol works, for reference:",
      '',
      '````',
      'To hand off, end your reply with:',
      '```' + HANDOFF_FENCE_TAG,
      '{"to":"codex","reason":"example only","prompt":"do not run this"}',
      '```',
      '````',
      '',
      'Given that, I am handing off now.',
      '',
      '```' + HANDOFF_FENCE_TAG,
      '{"to":"gemini","reason":"real handoff","prompt":"do the real thing"}',
      '```',
      '',
    ].join('\n');
    const idx = handoffFenceStartMasked(text);
    // The UNMASKED (buggy) index would be the QUOTED fence, inside the
    // example — the masked-aware index must be the LAST (real, unquoted)
    // occurrence instead.
    const unmaskedIdx = handoffFenceStart(text);
    const lastRealIdx = text.lastIndexOf('```' + HANDOFF_FENCE_TAG);
    expect(idx).toBe(lastRealIdx);
    expect(idx).not.toBe(unmaskedIdx);
    expect(idx).toBeGreaterThan(-1);
  });

  it('a partial (still-streaming) real fence after a fully-quoted example is still detected', () => {
    const text = [
      "Here's how the handoff protocol works, for reference:",
      '',
      '````',
      'To hand off, end your reply with:',
      '```' + HANDOFF_FENCE_TAG,
      '{"to":"codex","reason":"example only","prompt":"do not run this"}',
      '```',
      '````',
      '',
      'Given that, I am handing off now.',
      '',
      '```' + HANDOFF_FENCE_TAG,
      '{"to": ',
    ].join('\n');
    const idx = handoffFenceStartMasked(text);
    expect(idx).toBe(text.lastIndexOf('```' + HANDOFF_FENCE_TAG));
    expect(idx).toBeGreaterThan(-1);
  });
});

// ─── resolveHandoffTarget — alias/display-name normalization ───────────────
// fleet-1 codex-emitted-"Claude Code" incident: the agent used the DISPLAY
// NAME instead of the runtime id — this is the resolver that closes that gap.

describe('resolveHandoffTarget', () => {
  const RESOLVE_TARGETS = new Set(['claude', 'codex', 'gemini', 'kimi']);

  it('passes through a verbatim runtime id', () => {
    expect(resolveHandoffTarget('claude', RESOLVE_TARGETS)).toBe('claude');
  });

  it('is case-insensitive and trims whitespace on a verbatim id', () => {
    expect(resolveHandoffTarget('  CLAUDE  ', RESOLVE_TARGETS)).toBe('claude');
    expect(resolveHandoffTarget('Codex', RESOLVE_TARGETS)).toBe('codex');
  });

  it('resolves the shared-registry DISPLAY NAME "Claude Code" → claude', () => {
    expect(resolveHandoffTarget('Claude Code', RESOLVE_TARGETS)).toBe('claude');
  });

  it('resolves other display names — "Gemini CLI" → gemini, "Kimi Code" → kimi', () => {
    expect(resolveHandoffTarget('Gemini CLI', RESOLVE_TARGETS)).toBe('gemini');
    expect(resolveHandoffTarget('Kimi Code', RESOLVE_TARGETS)).toBe('kimi');
  });

  it('resolves the bare short form "Kimi" → kimi', () => {
    expect(resolveHandoffTarget('Kimi', RESOLVE_TARGETS)).toBe('kimi');
  });

  it('resolves the PUBLIC id "claude_code" (and hyphen/underscore variants) → claude', () => {
    expect(resolveHandoffTarget('claude_code', RESOLVE_TARGETS)).toBe('claude');
    expect(resolveHandoffTarget('claude-code', RESOLVE_TARGETS)).toBe('claude');
    expect(resolveHandoffTarget('CLAUDE_CODE', RESOLVE_TARGETS)).toBe('claude');
  });

  it('returns null for an unknown alias', () => {
    expect(resolveHandoffTarget('not-a-real-agent', RESOLVE_TARGETS)).toBeNull();
  });

  it('returns null for empty/whitespace-only input', () => {
    expect(resolveHandoffTarget('', RESOLVE_TARGETS)).toBeNull();
    expect(resolveHandoffTarget('   ', RESOLVE_TARGETS)).toBeNull();
  });

  it('returns null when the resolved id is not on THIS roster', () => {
    // "Codex CLI" resolves globally to "codex", but this roster doesn't have it.
    expect(resolveHandoffTarget('Codex CLI', new Set(['claude', 'gemini']))).toBeNull();
  });
});

// ─── extractHandoffProposal — degenerate/inline form ────────────────────────
// fleet-1 v2.65.x live bug: codex emitted a single-backtick INLINE code span
// instead of a 3-backtick fenced block, so the strict FENCE_RE never matched.

describe('extractHandoffProposal — degenerate/inline form', () => {
  it('a single-backtick inline code span with a valid, resolvable target is treated as a proposal and stripped', () => {
    const text =
      'Handing this off.\n\n`codeam-handoff {"to":"Claude Code","reason":"needs Claude","prompt":"finish the review"}`\n';
    const r = extractHandoffProposal(text, 'codex', new Set(['claude']));
    expect(r.proposal).toEqual({
      to: 'claude',
      reason: 'needs Claude',
      prompt: 'finish the review',
    });
    expect(r.cleanText).not.toContain('codeam-handoff');
    expect(r.cleanText).toBe('Handing this off.');
  });

  it('a bare (zero-backtick) degenerate line is also matched', () => {
    const text = 'Done.\n\ncodeam-handoff {"to":"codex","reason":"needs codex","prompt":"go"}';
    const r = extractHandoffProposal(text, 'claude', new Set(['codex']));
    expect(r.proposal).toEqual({ to: 'codex', reason: 'needs codex', prompt: 'go' });
    expect(r.cleanText).toBe('Done.');
  });

  it('a double-backtick inline span is also matched', () => {
    const text = '``codeam-handoff {"to":"codex","reason":"r","prompt":"p"}``';
    const r = extractHandoffProposal(text, 'claude', new Set(['codex']));
    expect(r.proposal).toEqual({ to: 'codex', reason: 'r', prompt: 'p' });
    expect(r.cleanText).toBe('');
  });

  it('CRITICAL SAFETY RULE: invalid JSON in a degenerate form leaves the text COMPLETELY untouched', () => {
    const text = 'Some notes.\n\n`codeam-handoff {not valid json}`\n';
    const r = extractHandoffProposal(text, 'claude', new Set(['codex']));
    expect(r.proposal).toBeNull();
    expect(r.cleanText).toBe(text);
  });

  it('CRITICAL SAFETY RULE: an unresolvable target in a degenerate form leaves the text COMPLETELY untouched', () => {
    const text =
      'Some notes.\n\n`codeam-handoff {"to":"not-a-real-agent","reason":"r","prompt":"p"}`\n';
    const r = extractHandoffProposal(text, 'claude', new Set(['codex']));
    expect(r.proposal).toBeNull();
    expect(r.cleanText).toBe(text);
  });

  it('does not eat ordinary prose that merely mentions the tag inline', () => {
    const text = 'The codeam-handoff protocol lets agents pass work to teammates.';
    const r = extractHandoffProposal(text, 'claude', new Set(['codex']));
    expect(r.proposal).toBeNull();
    expect(r.cleanText).toBe(text);
  });

  it('a degenerate mention inside a 4+-backtick worked example is left untouched, no proposal', () => {
    const text = [
      "Here's the degenerate form some agents mistakenly use:",
      '',
      '````',
      '`codeam-handoff {"to":"codex","reason":"example","prompt":"do not run"}`',
      '````',
      '',
    ].join('\n');
    const r = extractHandoffProposal(text, 'claude', new Set(['codex']));
    expect(r.proposal).toBeNull();
    expect(r.cleanText).toBe(text);
  });

  it('a strict fence still wins over a degenerate mention elsewhere in the same reply', () => {
    const text = [
      'codeam-handoff is neat but this is just prose about it, not a real block.',
      '',
      '```codeam-handoff',
      '{"to":"codex","reason":"the real one","prompt":"do the real thing"}',
      '```',
      '',
    ].join('\n');
    const r = extractHandoffProposal(text, 'claude', new Set(['codex']));
    expect(r.proposal).toEqual({
      to: 'codex',
      reason: 'the real one',
      prompt: 'do the real thing',
    });
    expect(r.cleanText).toContain('codeam-handoff is neat');
    expect(r.cleanText).not.toContain('do the real thing');
  });

  it('only the LAST degenerate match is considered when there are several', () => {
    const text = [
      '`codeam-handoff {"to":"codex","reason":"first","prompt":"first prompt"}`',
      '',
      '`codeam-handoff {"to":"codex","reason":"second","prompt":"second prompt"}`',
    ].join('\n');
    const r = extractHandoffProposal(text, 'claude', new Set(['codex']));
    expect(r.proposal).toEqual({ to: 'codex', reason: 'second', prompt: 'second prompt' });
  });
});

// ─── stripHandoffFences — degenerate/inline form ─────────────────────────────

describe('stripHandoffFences — degenerate/inline form', () => {
  it('strips a shape-valid degenerate block (no roster context needed here)', () => {
    const text =
      'Handing this off.\n\n`codeam-handoff {"to":"Claude Code","reason":"needs Claude","prompt":"finish the review"}`\n';
    const out = stripHandoffFences(text);
    expect(out).not.toContain('codeam-handoff');
    expect(out).toBe('Handing this off.');
  });

  it('leaves an invalid (non-JSON) degenerate mention untouched', () => {
    const text = 'Some notes.\n\n`codeam-handoff {not valid json}`\n';
    expect(stripHandoffFences(text)).toBe(text);
  });

  it('leaves ordinary prose mentioning the tag untouched', () => {
    const text = 'The codeam-handoff protocol lets agents pass work to teammates.';
    expect(stripHandoffFences(text)).toBe(text);
  });
});
