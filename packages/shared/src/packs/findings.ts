import {
  MAX_PACK_FINDINGS,
  PACK_HANDOFF_HEADING,
  type PackFinding,
  type PackFindingResolution,
  type PackFindingSeverity,
} from './types';

/**
 * Parsers for the two model-written handoff artifacts. Both are tolerant on
 * purpose: a stage that produced slightly-off output still hands off (with an
 * honest note), because a strict parser would turn a formatting slip into a
 * stalled pipeline — the exact failure mode structured handoffs exist to
 * remove. Never throws.
 */

const SEVERITIES: ReadonlySet<string> = new Set<PackFindingSeverity>([
  'blocker',
  'major',
  'minor',
  'nit',
]);
const RESOLUTIONS: ReadonlySet<string> = new Set<PackFindingResolution>([
  'fixed',
  'deferred',
  'wont_fix',
  'needs_verification',
]);

const TITLE_MAX = 200;
const DETAIL_MAX = 1200;

export interface ParsedPackFindings {
  findings: PackFinding[];
  /** What an empty list audited (`checked` in the file), when the stage said so. */
  checked?: string[];
  /** Human-readable caveat: entries dropped, list truncated. Absent when clean. */
  note?: string;
}

export type PackFindingsParseResult =
  { ok: true; value: ParsedPackFindings } | { ok: false; error: string };

/**
 * Parse the contents of `PACK_FINDINGS_FILE`. Accepts the documented shape
 * `{ "findings": [...], "checked"?: [...] }`, a bare array, and either wrapped
 * in a markdown fence. Individual entries are validated one by one: a bad entry
 * is dropped and counted in `note`, it never poisons the rest. Unknown
 * severity/resolution values are coerced to the conservative end
 * (`major` / `needs_verification`) rather than dropped — a mislabeled finding
 * is still a finding the next stage must look at.
 */
export function parsePackFindings(raw: string): PackFindingsParseResult {
  const text = stripFence(raw).trim();
  if (text.length === 0) return { ok: false, error: 'findings file is empty' };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    const salvaged = salvageJson(text);
    if (salvaged === null) return { ok: false, error: 'findings file is not valid JSON' };
    data = salvaged;
  }
  const container = Array.isArray(data) ? { findings: data } : data;
  if (!isRecord(container) || !Array.isArray(container.findings)) {
    return { ok: false, error: 'findings file has no "findings" array' };
  }

  const findings: PackFinding[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  for (const entry of container.findings) {
    const f = coerceFinding(entry, findings.length + 1);
    if (!f) {
      dropped += 1;
      continue;
    }
    if (seen.has(f.id)) f.id = `${f.id}-${findings.length + 1}`;
    seen.add(f.id);
    findings.push(f);
    if (findings.length >= MAX_PACK_FINDINGS) break;
  }
  const truncated = container.findings.length - dropped - findings.length;

  const checked = Array.isArray(container.checked)
    ? container.checked
        .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
        .slice(0, 20)
    : undefined;

  const notes: string[] = [];
  if (dropped > 0) notes.push(`${dropped} malformed entr${dropped === 1 ? 'y' : 'ies'} dropped`);
  if (truncated > 0)
    notes.push(`list truncated to ${MAX_PACK_FINDINGS} (${truncated} more in the file)`);

  return {
    ok: true,
    value: {
      findings,
      ...(checked && checked.length > 0 ? { checked } : {}),
      ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
    },
  };
}

function coerceFinding(entry: unknown, ordinal: number): PackFinding | null {
  if (!isRecord(entry)) return null;
  const title = str(entry.title) ?? str(entry.summary);
  if (!title) return null;
  const id = str(entry.id) ?? `R${ordinal}`;
  const severityRaw = (str(entry.severity) ?? '').toLowerCase();
  const resolutionRaw = (str(entry.resolution) ?? str(entry.status) ?? '')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const line =
    typeof entry.line === 'number' && Number.isFinite(entry.line) && entry.line > 0
      ? Math.floor(entry.line)
      : undefined;
  const detail = str(entry.detail) ?? str(entry.description);
  const file = str(entry.file) ?? str(entry.path);
  const commit = str(entry.commit);
  return {
    id: id.slice(0, 32),
    severity: (SEVERITIES.has(severityRaw) ? severityRaw : 'major') as PackFindingSeverity,
    title: title.slice(0, TITLE_MAX),
    ...(detail ? { detail: detail.slice(0, DETAIL_MAX) } : {}),
    ...(file ? { file: file.slice(0, 300) } : {}),
    ...(line !== undefined ? { line } : {}),
    resolution: (RESOLUTIONS.has(resolutionRaw)
      ? resolutionRaw
      : 'needs_verification') as PackFindingResolution,
    ...(commit && /^[0-9a-f]{7,40}$/i.test(commit) ? { commit: commit.slice(0, 10) } : {}),
  };
}

/**
 * Lift the `## Handoff` section from a stage reply (the workflow article asks
 * every stage to close with one). Returns null when the reply has no such
 * heading, so callers fall back to the reply's tail. Case-insensitive on the
 * heading text, tolerant of `#`/`###`, stops at the next heading of the same
 * or higher level.
 */
export function extractHandoffSection(reply: string): string | null {
  const lines = reply.split('\n');
  const want = PACK_HANDOFF_HEADING.replace(/^#+\s*/, '').toLowerCase();
  let start = -1;
  let level = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s{0,3}(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (
      m &&
      m[2]
        .trim()
        .toLowerCase()
        .replace(/[:.]+$/, '') === want
    ) {
      start = i;
      level = m[1].length;
      break;
    }
  }
  if (start < 0) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s{0,3}(#{1,6})\s+/);
    if (m && m[1].length <= level) break;
    body.push(lines[i]);
  }
  const text = body.join('\n').trim();
  return text.length > 0 ? text : null;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function stripFence(raw: string): string {
  const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return m ? m[1] : raw;
}

/** Last resort: the first `{…}` or `[…]` span that parses. */
function salvageJson(text: string): unknown | null {
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const a = text.indexOf(open);
    const b = text.lastIndexOf(close);
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(text.slice(a, b + 1));
      } catch {
        /* try the other bracket */
      }
    }
  }
  return null;
}
