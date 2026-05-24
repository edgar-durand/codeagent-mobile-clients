import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseReview } from '../../../src/agents/coderabbit/parsing';

const FIXTURE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'fixtures', 'coderabbit', 'sample-review.txt'),
  'utf8',
);

describe('coderabbit/parseReview', () => {
  const parsed = parseReview(FIXTURE);

  it('keeps the full markdown blob', () => {
    expect(parsed.markdown).toContain('## CodeRabbit Review');
    expect(parsed.markdown).toContain('### Next steps');
  });

  it('extracts 5 hunks from the sample review', () => {
    expect(parsed.hunks.length).toBe(5);
  });

  it('maps severities correctly across the warn/error/info keywords', () => {
    const sev = parsed.hunks.map((h) => h.severity);
    expect(sev).toContain('warn');
    expect(sev).toContain('error');
    expect(sev).toContain('info');
  });

  it('captures file path + line number for each hunk', () => {
    const first = parsed.hunks[0];
    expect(first.path).toBe('src/services/relay.ts');
    expect(first.line).toBe(54);
    expect(first.message).toContain('missing await');
  });

  it('parses lines using different delimiter styles (— : [])', () => {
    // The fixture mixes em-dash, colon, and [bracket] severity styles.
    // All three should produce hunks with the right severity classified.
    const errHunk = parsed.hunks.find((h) => h.line === 118);
    expect(errHunk?.severity).toBe('error');

    const infoHunk = parsed.hunks.find((h) => h.line === 201);
    expect(infoHunk?.severity).toBe('info');

    const warnHunk = parsed.hunks.find((h) => h.line === 32);
    expect(warnHunk?.severity).toBe('warn');
  });

  it('strips markdown bullet prefixes from messages', () => {
    // None of the fixture lines start with `* `/`- ` but the cleaner is
    // exercised here as a regression guard: future fixtures that DO
    // include bullets shouldn't leak them into the rendered message.
    const synthetic = 'src/foo.ts:10: - warning: bullet leak';
    const { hunks } = parseReview(synthetic);
    expect(hunks[0]?.message).not.toMatch(/^[*-]\s/);
  });

  it('returns stats with lines reviewed + hunk count', () => {
    expect(parsed.stats.hunkCount).toBe(5);
    expect(Number(parsed.stats.linesReviewed)).toBeGreaterThan(0);
  });

  it('returns empty hunks on noise input without any annotations', () => {
    const { hunks, markdown } = parseReview('just a plain markdown blob\nno annotations here');
    expect(hunks).toEqual([]);
    expect(markdown).toContain('plain markdown blob');
  });
});
