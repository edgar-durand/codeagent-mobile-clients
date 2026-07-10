/**
 * Parser for CodeRabbit CLI review output.
 *
 * The reviewer is invoked as `coderabbit review --agent` (structured,
 * machine-readable — the default for our surfaces) or `--plain` (human
 * text). This module normalises EITHER into a {@link ParsedReview}.
 *
 * ⚠️ CodeRabbit does NOT publish the exact `--agent` JSON schema, and it
 * can shift between releases, so the JSON extractor is deliberately
 * SHAPE-TOLERANT rather than pinned to one field layout:
 *   - stdout may be a single JSON object OR NDJSON (one object per line);
 *   - findings may be a flat `findings`/`comments`/`issues` array OR
 *     grouped by severity (`{ critical: [...], warning: [...], info: [...] }`);
 *   - each finding's fields are read through a list of known aliases
 *     (file/path, line/line_range, severity/level, title, comment/message,
 *     prompt/fix).
 * Known facts (CLI 0.6.x + the official code-review skill): severities are
 * **Critical / Warning / Info**; findings carry a file, a line/line-range,
 * a message and an agent fix-prompt. Anything unrecognised degrades to
 * "raw stdout in the markdown field" + the plain-text regex fallback, so a
 * wire bump never hard-errors. Validate field aliases against a live
 * `coderabbit review --agent` capture before trusting new ones.
 */

import type { BatchInvocationOutput } from '../strategy';

type Hunk = NonNullable<BatchInvocationOutput['hunks']>[number];

export interface ParsedReview {
  markdown: string;
  hunks: NonNullable<BatchInvocationOutput['hunks']>;
  stats: NonNullable<BatchInvocationOutput['stats']>;
}

// Plain-text fallback (`--plain` output / unparseable JSON). Matches:
//   `src/foo.ts:42 — warning: missing await on async call`
//   `src/foo.ts:42: missing await on async call`
//   `path/to/file:10 [error] message text`
const HUNK_LINE_RE =
  /^([^\s:][^:]*?):(\d+)[\s:—-]+(?:\[?(info|warn|warning|error|critical)\]?[:\s—-]+)?(.+)$/i;

const SEVERITY_MAP: Record<string, 'info' | 'warn' | 'error'> = {
  info: 'info',
  note: 'info',
  low: 'info',
  minor: 'info',
  warn: 'warn',
  warning: 'warn',
  medium: 'warn',
  major: 'warn',
  error: 'error',
  critical: 'error',
  high: 'error',
  blocker: 'error',
};

function normSeverity(v: unknown): Hunk['severity'] | undefined {
  if (typeof v !== 'string') return undefined;
  return SEVERITY_MAP[v.trim().toLowerCase()];
}

/** First present value among candidate keys on an object. */
function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}

/** Extract a starting line from a scalar or a `{start,end}` / `[start,end]` range. */
function pickLine(obj: Record<string, unknown>): number | undefined {
  const direct = pick(obj, ['line', 'start_line', 'startLine', 'line_number', 'lineNumber']);
  if (typeof direct === 'number') return direct;
  if (typeof direct === 'string' && /^\d+$/.test(direct)) return Number(direct);
  const range = pick(obj, ['line_range', 'lineRange', 'range', 'lines']);
  if (Array.isArray(range) && typeof range[0] === 'number') return range[0];
  if (range && typeof range === 'object') {
    const start = pick(range as Record<string, unknown>, ['start', 'begin', 'from']);
    if (typeof start === 'number') return start;
    if (start && typeof start === 'object') {
      const l = (start as Record<string, unknown>).line;
      if (typeof l === 'number') return l;
    }
  }
  return undefined;
}

/** Map one finding-shaped object to a Hunk, or null if it has no locatable file. */
function toHunk(raw: unknown, groupSeverity?: string): Hunk | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const path =
    asString(pick(o, ['file_path', 'filePath', 'file', 'path', 'filename', 'fileName'])) ??
    asString((pick(o, ['location']) as Record<string, unknown> | undefined)?.path);
  if (!path) return null;
  // `codegenInstructions` is the finding body in the live `--agent` NDJSON
  // (`{type:'finding',severity:'minor',fileName,codegenInstructions,suggestions}`);
  // without it the finding parses to "(no message)".
  const message =
    asString(
      pick(o, [
        'comment',
        'message',
        'body',
        'description',
        'codegenInstructions',
        'summary',
        'markdown',
        'text',
      ]),
    ) ?? '';
  const title = asString(pick(o, ['title', 'rule', 'category', 'check']));
  const severity = normSeverity(pick(o, ['severity', 'level', 'priority', 'impact'])) ?? normSeverity(groupSeverity);
  const locObj = (pick(o, ['location']) as Record<string, unknown>) ?? o;
  return {
    path: path.trim(),
    line: pickLine(o) ?? pickLine(locObj),
    severity,
    message: (title && message ? `${title}: ${message}` : title || message).trim() || '(no message)',
  };
}

/** Pull findings out of a parsed JSON value in any of the shapes CodeRabbit uses. */
function findingsFrom(value: unknown): Hunk[] {
  const out: Hunk[] = [];
  if (!value || typeof value !== 'object') return out;
  const root = value as Record<string, unknown>;
  // Flat array under a well-known key.
  const flat = pick(root, ['findings', 'comments', 'issues', 'results', 'review_comments', 'reviewComments']);
  if (Array.isArray(flat)) {
    for (const f of flat) {
      const h = toHunk(f);
      if (h) out.push(h);
    }
  }
  // Severity-grouped object, either at the root or under `findings`.
  const grouped = (flat && !Array.isArray(flat) ? flat : root) as Record<string, unknown>;
  for (const sev of ['critical', 'warning', 'warn', 'error', 'info', 'note']) {
    const bucket = grouped[sev];
    if (Array.isArray(bucket)) {
      for (const f of bucket) {
        const h = toHunk(f, sev);
        if (h) out.push(h);
      }
    }
  }
  return out;
}

/** Extract a human-readable error message from a `{type:'error',...}` event.
 *  Verified live: `--agent` streams NDJSON control events, and a failed run
 *  ends with `{"type":"error","errorType":"connection","message":"Connection
 *  failed: Invalid or expired API key","recoverable":...,"details":{...}}`. */
function errorFrom(obj: Record<string, unknown>): string | undefined {
  if (obj.type !== 'error') return undefined;
  return asString(pick(obj, ['message', 'error']));
}

/** Non-finding control events observed live (`--agent` NDJSON): skip them.
 *  `heartbeat` (`{type:'heartbeat',status:'reviewing'}`) is emitted while the
 *  review runs — must be skipped too, else it's dumped as raw JSON. */
function isControlEvent(obj: Record<string, unknown>): boolean {
  return (
    obj.type === 'review_context' ||
    obj.type === 'status' ||
    obj.type === 'progress' ||
    obj.type === 'heartbeat' ||
    obj.type === 'error'
  );
}

/** Extract a human summary from a `{type:'summary',...}` event, if present. */
function summaryFrom(obj: Record<string, unknown>): string | undefined {
  if (obj.type !== 'summary') return undefined;
  return asString(pick(obj, ['content', 'text', 'markdown', 'summary', 'body']));
}

/** Parse stdout as a single JSON object, else as NDJSON, collecting findings. */
function parseStructured(stdout: string): { hunks: Hunk[]; summary?: string; error?: string } | null {
  const trimmed = stdout.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  // Single JSON document.
  try {
    const doc = JSON.parse(trimmed);
    const hunks = findingsFrom(Array.isArray(doc) ? { findings: doc } : doc);
    const summary = asString(
      pick((Array.isArray(doc) ? {} : doc) as Record<string, unknown>, ['summary', 'markdown', 'report', 'overview']),
    );
    if (hunks.length > 0 || summary) return { hunks, summary };
  } catch {
    /* fall through to NDJSON */
  }
  // NDJSON: one object per line (control events, findings, and/or a summary).
  const hunks: Hunk[] = [];
  let summary: string | undefined;
  let error: string | undefined;
  let sawJson = false;
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || (l[0] !== '{' && l[0] !== '[')) continue;
    try {
      const obj = JSON.parse(l);
      sawJson = true;
      const rec = (Array.isArray(obj) ? {} : obj) as Record<string, unknown>;
      // First error wins — the root cause ("Invalid or expired API key")
      // precedes the generic terminal wrapper ("Review failed: Unknown error").
      error ??= errorFrom(rec);
      summary ??= summaryFrom(rec);
      if (isControlEvent(rec)) continue;
      const found = findingsFrom(Array.isArray(obj) ? { findings: obj } : obj);
      if (found.length > 0) hunks.push(...found);
      else {
        const single = toHunk(obj);
        if (single) hunks.push(single);
      }
      summary ??= asString(pick(rec, ['summary', 'markdown', 'report']));
    } catch {
      /* skip non-JSON line */
    }
  }
  return sawJson ? { hunks, summary, error } : null;
}

/** Plain-text fallback for `--plain` output or unparseable JSON. */
function parsePlain(stdout: string): Hunk[] {
  const hunks: Hunk[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(HUNK_LINE_RE);
    if (!m) continue;
    const [, path, lineNo, sevToken, message] = m;
    if (!path || !lineNo || !message) continue;
    hunks.push({
      path: path.trim(),
      line: Number(lineNo),
      severity: sevToken ? SEVERITY_MAP[sevToken.toLowerCase()] : undefined,
      message: message.trim().replace(/^[*-]\s+/, ''),
    });
  }
  return hunks;
}

/** Human one-liner from finding counts, for when the reviewer emitted findings
 *  but no summary text (so the summary card isn't the raw event stream). */
function synthesizeSummary(counts: Record<string, number>, total: number): string {
  const parts: string[] = [];
  if (counts.error) parts.push(`${counts.error} critical`);
  if (counts.warn) parts.push(`${counts.warn} warning`);
  if (counts.info) parts.push(`${counts.info} suggestion${counts.info === 1 ? '' : 's'}`);
  const noun = total === 1 ? 'finding' : 'findings';
  return parts.length > 0
    ? `CodeRabbit found ${total} ${noun} (${parts.join(', ')}).`
    : `CodeRabbit found ${total} ${noun}.`;
}

function severityCounts(hunks: Hunk[]): Record<string, number> {
  const c = { error: 0, warn: 0, info: 0 } as Record<string, number>;
  for (const h of hunks) if (h.severity) c[h.severity] += 1;
  return c;
}

/**
 * Parse a captured CodeRabbit stdout blob into a structured review. Pure
 * function (no I/O, no clock) so it stays trivial to unit-test against
 * captured fixtures. Prefers the structured `--agent` JSON; falls back to
 * the plain-text line regex; always returns something renderable.
 */
export function parseReview(stdout: string): ParsedReview {
  const structured = parseStructured(stdout);
  const hunks = structured && structured.hunks.length > 0 ? structured.hunks : parsePlain(stdout);
  const counts = severityCounts(hunks);
  // Markdown summary rules — the raw `--agent` NDJSON must NEVER reach the UI
  // (it's an unreadable event stream, adds zero value). Precedence:
  //   1. a real summary the reviewer emitted;
  //   2. an error message when the run failed with no findings (actionable);
  //   3. a synthesized one-liner from the finding counts when there ARE findings
  //      but no summary — the hunks carry the detail, this just tops the card;
  //   4. empty when the review was structured but clean (the "no issues" banner
  //      speaks for it) — NOT the raw stdout;
  //   5. only when the output was NOT structured at all (genuine `--plain`
  //      text) do we surface stdout verbatim.
  let markdown: string;
  if (structured?.summary) {
    markdown = structured.summary;
  } else if (structured) {
    if (hunks.length === 0 && structured.error) {
      markdown = structured.error;
    } else if (hunks.length > 0) {
      markdown = synthesizeSummary(counts, hunks.length);
    } else {
      markdown = '';
    }
  } else {
    markdown = stdout;
  }
  markdown = markdown.trim();
  return {
    markdown,
    hunks,
    stats: {
      findingCount: hunks.length,
      critical: counts.error,
      warning: counts.warn,
      info: counts.info,
      ...(structured?.error ? { error: structured.error } : {}),
    },
  };
}
