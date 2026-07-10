import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseReview } from '../../../src/agents/coderabbit/parsing';

const FIXTURE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'fixtures', 'coderabbit', 'sample-review.txt'),
  'utf8',
);

// Plain-text (`--plain`) output — the FALLBACK path.
describe('coderabbit/parseReview — plain-text fallback', () => {
  const parsed = parseReview(FIXTURE);

  it('keeps the full markdown blob', () => {
    expect(parsed.markdown).toContain('## CodeRabbit Review');
  });

  it('extracts 5 hunks from the sample review', () => {
    expect(parsed.hunks.length).toBe(5);
  });

  it('maps severities across warn/error/info', () => {
    const sev = parsed.hunks.map((h) => h.severity);
    expect(sev).toContain('warn');
    expect(sev).toContain('error');
    expect(sev).toContain('info');
  });

  it('captures file path + line for each hunk', () => {
    const first = parsed.hunks[0];
    expect(first.path).toBe('src/services/relay.ts');
    expect(first.line).toBe(54);
    expect(first.message).toContain('missing await');
  });

  it('reports finding + severity counts in stats', () => {
    expect(parsed.stats.findingCount).toBe(5);
    expect(Number(parsed.stats.critical)).toBeGreaterThanOrEqual(1);
  });

  it('returns empty hunks on noise input', () => {
    const { hunks, markdown } = parseReview('just a plain markdown blob\nno annotations here');
    expect(hunks).toEqual([]);
    expect(markdown).toContain('plain markdown blob');
  });
});

// Structured `--agent` JSON — the PRIMARY path. The exact schema isn't
// published, so these assert the SHAPE-TOLERANT contract: findings are
// extracted from a flat array, a severity-grouped object, and NDJSON, with
// defensive field aliases. Tighten the aliases once a live capture confirms them.
describe('coderabbit/parseReview — structured --agent JSON', () => {
  it('extracts findings from a flat `findings` array with a summary', () => {
    const json = JSON.stringify({
      summary: 'Reviewed 3 files, found 2 issues.',
      findings: [
        {
          file: 'src/a.ts',
          line: 42,
          severity: 'critical',
          title: 'SQL injection',
          comment: 'User input flows into a raw query.',
        },
        {
          file_path: 'src/b.ts',
          line_range: { start: 10, end: 12 },
          level: 'info',
          message: 'Prefer const.',
        },
      ],
    });
    const { hunks, markdown, stats } = parseReview(json);
    expect(hunks.length).toBe(2);
    expect(markdown).toBe('Reviewed 3 files, found 2 issues.');
    expect(hunks[0]).toMatchObject({ path: 'src/a.ts', line: 42, severity: 'error' });
    expect(hunks[0].message).toContain('SQL injection');
    expect(hunks[1]).toMatchObject({ path: 'src/b.ts', line: 10, severity: 'info' });
    expect(stats.findingCount).toBe(2);
    expect(stats.critical).toBe(1);
    expect(stats.info).toBe(1);
  });

  it('extracts findings grouped by severity', () => {
    const json = JSON.stringify({
      critical: [{ file: 'x.ts', line: 1, message: 'boom' }],
      warning: [{ file: 'y.ts', line: 2, message: 'careful' }],
      info: [{ file: 'z.ts', line: 3, message: 'nit' }],
    });
    const { hunks } = parseReview(json);
    expect(hunks.map((h) => h.severity)).toEqual(['error', 'warn', 'info']);
    expect(hunks.map((h) => h.path)).toEqual(['x.ts', 'y.ts', 'z.ts']);
  });

  it('extracts findings from NDJSON (one object per line)', () => {
    const ndjson = [
      JSON.stringify({ type: 'finding', file: 'src/a.ts', line: 5, severity: 'warning', message: 'w' }),
      JSON.stringify({ type: 'finding', file: 'src/b.ts', line: 6, severity: 'critical', message: 'c' }),
    ].join('\n');
    const { hunks } = parseReview(ndjson);
    expect(hunks.length).toBe(2);
    expect(hunks[1]).toMatchObject({ path: 'src/b.ts', line: 6, severity: 'error' });
  });

  it('never dumps raw JSON as the summary when there are no findings', () => {
    // Structured JSON we can't extract findings from → the summary card must NOT
    // become the raw event blob (the unreadable-UI report). Empty is correct;
    // the "no issues" banner speaks for it.
    const json = JSON.stringify({ status: 'ok', unrelated: true });
    const { hunks, markdown } = parseReview(json);
    expect(hunks).toEqual([]);
    expect(markdown).toBe('');
    expect(markdown).not.toContain('"status"');
  });

  it('parses the REAL --agent finding shape (fileName + codegenInstructions + heartbeat)', () => {
    // Verbatim shape from the 2026-07-10 codespace review that rendered raw
    // NDJSON in the UI: findings key on `fileName`/`codegenInstructions`, plus a
    // `heartbeat` control event that must be skipped (not dumped).
    const ndjson = [
      '{"type":"review_context","reviewType":"uncommitted","currentBranch":"dev","baseBranch":"dev","workingDirectory":"/workspaces/app"}',
      '{"type":"status","phase":"analyzing","status":"reviewing"}',
      '{"type":"heartbeat","status":"reviewing"}',
      '{"type":"finding","severity":"minor","fileName":"CLAUDE.md","codegenInstructions":"Replace the template placeholders with project-specific guidance.","suggestions":[]}',
      '{"type":"finding","severity":"minor","fileName":"README.md","codegenInstructions":"Fix the malformed Markdown heading.","suggestions":["## Error Monitoring (Sentry)"]}',
    ].join('\n');
    const { hunks, markdown, stats } = parseReview(ndjson);
    expect(hunks.length).toBe(2);
    expect(hunks[0]).toMatchObject({
      path: 'CLAUDE.md',
      severity: 'info', // "minor" → info
      message: 'Replace the template placeholders with project-specific guidance.',
    });
    expect(hunks[1]).toMatchObject({ path: 'README.md', severity: 'info' });
    // The summary card is a readable one-liner, NEVER the raw event stream.
    expect(markdown).not.toContain('"type"');
    expect(markdown).not.toContain('codegenInstructions');
    expect(markdown).toContain('2 findings');
    expect(stats.findingCount).toBe(2);
    expect(stats.info).toBe(2);
  });

  it('prefers a real summary event over the synthesized one-liner', () => {
    const ndjson = [
      '{"type":"finding","severity":"critical","fileName":"a.ts","codegenInstructions":"boom"}',
      '{"type":"summary","content":"Reviewed 1 file; 1 critical issue to address."}',
    ].join('\n');
    const { hunks, markdown } = parseReview(ndjson);
    expect(hunks.length).toBe(1);
    expect(hunks[0]).toMatchObject({ path: 'a.ts', severity: 'error' });
    expect(markdown).toBe('Reviewed 1 file; 1 critical issue to address.');
  });

  it('surfaces the root-cause error from a failed --agent run (REAL captured NDJSON)', () => {
    // Verbatim from a live `coderabbit review --agent` run (2026-07-09):
    // control events, then the connection error, then a generic wrapper.
    const ndjson = [
      '{"type":"review_context","reviewType":"uncommitted","currentBranch":"main","baseBranch":"main","workingDirectory":"/tmp/x"}',
      '{"type":"status","phase":"connecting","status":"connecting_to_review_service"}',
      '{"type":"error","errorType":"connection","message":"Connection failed: Invalid or expired API key","recoverable":true,"details":{"data":{"code":"UNAUTHORIZED","httpStatus":401}}}',
      '{"type":"error","errorType":"review","message":"Review failed: Unknown error","recoverable":false,"details":{}}',
    ].join('\n');
    const { hunks, markdown, stats } = parseReview(ndjson);
    expect(hunks).toEqual([]); // control + error events produce no findings
    // The actionable root cause wins over the generic terminal wrapper.
    expect(markdown).toBe('Connection failed: Invalid or expired API key');
    expect(stats.error).toBe('Connection failed: Invalid or expired API key');
  });
});
