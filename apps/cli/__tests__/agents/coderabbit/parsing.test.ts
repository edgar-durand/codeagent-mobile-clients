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

  it('degrades to raw markdown when JSON has no recognizable findings', () => {
    const json = JSON.stringify({ status: 'ok', unrelated: true });
    const { hunks, markdown } = parseReview(json);
    expect(hunks).toEqual([]);
    expect(markdown).toContain('"status":"ok"');
  });
});
