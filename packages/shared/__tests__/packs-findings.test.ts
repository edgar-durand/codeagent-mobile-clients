import { describe, it, expect } from 'vitest';
import {
  MAX_PACK_FINDINGS,
  PACK_REGISTRY,
  extractHandoffSection,
  parsePackFindings,
  QA_PROMPT,
  REVIEWER_PROMPT,
  PACK_WORKFLOW_ARTICLE,
} from '../src';

describe('parsePackFindings — the Reviewer → QA artifact', () => {
  it('parses the documented shape and keeps every field', () => {
    const res = parsePackFindings(
      JSON.stringify({
        findings: [
          {
            id: 'R1',
            severity: 'blocker',
            title: 'token logged in plain text',
            detail: 'apiKey printed on startup',
            file: 'src/boot.ts',
            line: 7,
            resolution: 'fixed',
            commit: 'abcdef1234',
          },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.findings).toEqual([
      {
        id: 'R1',
        severity: 'blocker',
        title: 'token logged in plain text',
        detail: 'apiKey printed on startup',
        file: 'src/boot.ts',
        line: 7,
        resolution: 'fixed',
        commit: 'abcdef1234',
      },
    ]);
    expect(res.value.note).toBeUndefined();
  });

  it('tolerates a bare array, a markdown fence, and JSON embedded in prose', () => {
    const one = [{ id: 'R1', severity: 'minor', title: 'x', resolution: 'deferred' }];
    for (const raw of [
      JSON.stringify(one),
      '```json\n' + JSON.stringify({ findings: one }) + '\n```',
      'Here are my findings:\n' + JSON.stringify({ findings: one }) + '\nDone.',
    ]) {
      const res = parsePackFindings(raw);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.findings).toHaveLength(1);
    }
  });

  it('coerces unknown severity/resolution to the conservative end and drops entries without a title', () => {
    const res = parsePackFindings(
      JSON.stringify({
        findings: [
          { title: 'no severity, no resolution' },
          { severity: 'HIGH', status: 'Needs Verification', title: 'spelled differently' },
          { detail: 'no title at all' },
          'not an object',
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.findings.map((f) => [f.id, f.severity, f.resolution])).toEqual([
      ['R1', 'major', 'needs_verification'],
      ['R2', 'major', 'needs_verification'],
    ]);
    expect(res.value.note).toBe('2 malformed entries dropped');
  });

  it('an empty list with `checked` is a valid, honest result', () => {
    const res = parsePackFindings(
      JSON.stringify({ findings: [], checked: ['error paths of X', 'tests of Y'] }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.findings).toEqual([]);
      expect(res.value.checked).toEqual(['error paths of X', 'tests of Y']);
    }
  });

  it('de-duplicates ids, drops a non-hex commit, truncates a runaway list', () => {
    const many = Array.from({ length: MAX_PACK_FINDINGS + 5 }, (_, i) => ({
      id: 'R1',
      severity: 'nit',
      title: `f${i}`,
      resolution: 'fixed',
      commit: i === 0 ? 'not-a-sha' : 'abcdef1234',
    }));
    const res = parsePackFindings(JSON.stringify({ findings: many }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.findings).toHaveLength(MAX_PACK_FINDINGS);
    expect(new Set(res.value.findings.map((f) => f.id)).size).toBe(MAX_PACK_FINDINGS);
    expect(res.value.findings[0].commit).toBeUndefined();
    expect(res.value.note).toContain(`truncated to ${MAX_PACK_FINDINGS}`);
  });

  it('reports why when the file is unusable, never throws', () => {
    expect(parsePackFindings('')).toEqual({ ok: false, error: 'findings file is empty' });
    expect(parsePackFindings('{{{ nope')).toEqual({
      ok: false,
      error: 'findings file is not valid JSON',
    });
    expect(parsePackFindings('{"foo": 1}')).toEqual({
      ok: false,
      error: 'findings file has no "findings" array',
    });
  });
});

describe('extractHandoffSection', () => {
  it('lifts the section under `## Handoff` and stops at the next same-level heading', () => {
    const reply =
      'I did things.\n\n## Handoff\nImplemented #1-#3.\nTests in src/x.test.ts.\n\n## Notes\nunrelated';
    expect(extractHandoffSection(reply)).toBe('Implemented #1-#3.\nTests in src/x.test.ts.');
  });

  it('accepts other heading levels and trailing punctuation; null without the heading', () => {
    expect(extractHandoffSection('### Handoff:\nline')).toBe('line');
    expect(extractHandoffSection('# handoff\nline')).toBe('line');
    expect(extractHandoffSection('no section here')).toBeNull();
    expect(extractHandoffSection('## Handoff\n\n')).toBeNull();
  });
});

describe('the prompts carry the structured-handoff contract', () => {
  it('Reviewer writes the findings file; QA reads it; every role closes with ## Handoff', () => {
    expect(REVIEWER_PROMPT).toContain('REVIEW-FINDINGS.pack.json');
    expect(REVIEWER_PROMPT).toContain(
      '"resolution": "fixed | deferred | wont_fix | needs_verification"',
    );
    expect(QA_PROMPT).toContain('REVIEW-FINDINGS.pack.json');
    expect(QA_PROMPT).toContain('every finding id from the Reviewer appears in the report');
    for (const pack of Object.values(PACK_REGISTRY)) {
      for (const stage of pack.stages) expect(stage.prompt).toContain('## Handoff');
      const reviewer = pack.stages.find((s) => s.role === 'reviewer');
      expect(reviewer?.producesFindings).toBe(true);
    }
    expect(PACK_WORKFLOW_ARTICLE).toContain('## Handoff');
    // Questions must end in numbered options — that is what the CLI detects as a select prompt.
    expect(PACK_WORKFLOW_ARTICLE).toContain('numbered options');
  });
});
