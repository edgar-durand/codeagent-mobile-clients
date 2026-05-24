/**
 * Parser for CodeRabbit CLI output.
 *
 * CodeRabbit's `coderabbit review` emits a mixed stream: a markdown
 * summary at the top, then per-file annotation blocks. The exact
 * format is documented at https://www.coderabbit.ai/cli but is
 * subject to change between releases — we keep the parser tolerant
 * (best-effort extraction) so a minor wire bump degrades to "raw
 * stdout in markdown field" rather than a hard error.
 *
 * Two extraction targets:
 *   - `markdown` — the human-facing report. By default the whole
 *     stdout; when the CLI emits a discoverable separator we trim
 *     to the summary section.
 *   - `hunks` — structured `{ path, line, severity, message }`
 *     entries the mobile UI can render as inline file annotations.
 *     Extracted via a forgiving regex over `path:line — message`
 *     style lines (CodeRabbit's default review output).
 */

import type { BatchInvocationOutput } from '../strategy';

// Matches lines like:
//   `src/foo.ts:42 — warning: missing await on async call`
//   `src/foo.ts:42: missing await on async call`
//   `path/to/file:10 [error] message text`
// The `severity` capture is optional; we map the most common
// keywords to the BatchInvocationOutput severity union.
const HUNK_LINE_RE =
  /^([^\s:][^:]*?):(\d+)[\s:—-]+(?:\[?(info|warn|warning|error|critical)\]?[:\s—-]+)?(.+)$/i;

const SEVERITY_MAP: Record<string, 'info' | 'warn' | 'error'> = {
  info: 'info',
  warn: 'warn',
  warning: 'warn',
  error: 'error',
  critical: 'error',
};

export interface ParsedReview {
  markdown: string;
  hunks: NonNullable<BatchInvocationOutput['hunks']>;
  stats: NonNullable<BatchInvocationOutput['stats']>;
}

/**
 * Parse a captured CodeRabbit stdout blob into a structured review.
 * Pure function — no I/O, no clock — so it stays trivial to unit
 * test against captured fixtures.
 */
export function parseReview(stdout: string): ParsedReview {
  const hunks: ParsedReview['hunks'] = [];
  // Tolerate CRLF input — fixtures checked out on Windows via
  // git's autocrlf get \r\n line endings, and CodeRabbit's stdout
  // is itself unpredictable on Windows runners. The line-anchored
  // regex doesn't match when a trailing \r leaks through.
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(HUNK_LINE_RE);
    if (!m) continue;
    const [, path, lineNo, sevToken, message] = m;
    if (!path || !lineNo || !message) continue;
    // CodeRabbit sometimes prefixes its prose with markdown bullets
    // (`* `, `- `, etc.). Strip those so the rendered annotation
    // doesn't show "- message" with a dangling dash.
    const cleanedMessage = message.trim().replace(/^[*-]\s+/, '');
    hunks.push({
      path: path.trim(),
      line: Number(lineNo),
      severity: sevToken ? SEVERITY_MAP[sevToken.toLowerCase()] : undefined,
      message: cleanedMessage,
    });
  }

  return {
    markdown: stdout.trim(),
    hunks,
    stats: { linesReviewed: lines.length, hunkCount: hunks.length },
  };
}
