/**
 * History helpers for Cursor.
 *
 * `cursor-agent` writes a per-session transcript at
 *   `~/.cursor/projects/<encoded-cwd>/agent-transcripts/<sessionId>/<sessionId>.jsonl`
 * where `<encoded-cwd>` is the cwd with the leading separator stripped and every
 * path separator replaced by `-` (`/Users/x/Documents/p` → `Users-x-Documents-p`).
 *
 * Reverse-engineered from a real Cursor 2026.06.24 install (2026-07-08). Each
 * JSONL line is one record:
 *   {"role":"user","message":{"content":[{"type":"text","text":"<user_query>…</user_query>"}]}}
 *   {"role":"assistant","message":{"content":[{"type":"text","text":"…"}]}}
 *   {"type":"turn_ended","status":"…"}                            ← boundary, skipped
 *
 * Powers the baton read-only mirror (LOCAL_DRIVE) + the mobile session feed.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { NormalizedMessage } from '@codeam/shared';

const HISTORY_ROOT = path.join(os.homedir(), '.cursor', 'projects');

/** Cursor's project-dir encoding: strip the leading separator, then replace
 *  `/ \ :` with `-` (`/Users/x/p` → `Users-x-p`). */
export function encodeCursorCwd(cwd: string): string {
  return cwd.replace(/^[/\\]+/, '').replace(/[/\\:]/g, '-');
}

/**
 * Resolve the transcript file for a specific session. Tries the computed
 * `<encoded-cwd>` dir first, then falls back to scanning every project dir for
 * the `agent-transcripts/<sessionId>/<sessionId>.jsonl` subtree — the sessionId
 * is a globally-unique UUID, so the scan can't collide across projects and it
 * survives any cwd-encoding quirk.
 */
export function resolveHistoryFile(
  cwd: string,
  sessionId: string,
  root: string = HISTORY_ROOT,
): string | null {
  const rel = path.join('agent-transcripts', sessionId, `${sessionId}.jsonl`);
  const primary = path.join(root, encodeCursorCwd(cwd), rel);
  if (fs.existsSync(primary)) return primary;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null; // ~/.cursor/projects absent → no history yet
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const candidate = path.join(root, e.name, rel);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveHistoryDir(cwd: string): string | null {
  if (!fs.existsSync(HISTORY_ROOT)) return null;
  const dir = path.join(HISTORY_ROOT, encodeCursorCwd(cwd));
  return fs.existsSync(dir) ? dir : null;
}

interface CursorContentBlock {
  type?: string;
  text?: string;
}
interface CursorRecord {
  role?: 'user' | 'assistant';
  type?: string;
  message?: { content?: CursorContentBlock[] };
}

/** Concatenate the `text` of every `type:'text'` block, dropping tool/other blocks. */
function extractText(content: CursorContentBlock[] | undefined): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
}

/** Strip Cursor's `<user_query>…</user_query>` envelope so the mirror shows the
 *  raw prompt the user typed, not the agent-protocol wrapper. */
function unwrapUserQuery(text: string): string {
  const m = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  return (m ? m[1] : text).trim();
}

export function parseHistoryFile(filePath: string): NormalizedMessage[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const out: NormalizedMessage[] = [];
  let idx = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec: CursorRecord;
    try {
      rec = JSON.parse(line) as CursorRecord;
    } catch {
      continue;
    }
    // Only user/assistant messages carry conversation text; skip turn_ended etc.
    if (rec.role !== 'user' && rec.role !== 'assistant') continue;
    const blockText = extractText(rec.message?.content);
    const text = rec.role === 'user' ? unwrapUserQuery(blockText) : blockText.trim();
    if (!text) continue;
    out.push({
      id: `cursor:${idx}`,
      role: rec.role === 'user' ? 'user' : 'agent',
      text,
      // Cursor records carry no per-message timestamp; order is preserved by
      // file position, so a stable epoch keeps the shape valid without lying.
      timestamp: new Date(0).toISOString(),
    });
    idx += 1;
  }
  return out;
}

/** Quota / usage RPC stub. Cursor exposes usage via its own SaaS
 *  API (not surfaced through the CLI today). */
export function getCurrentUsage(_historyDir: string): {
  used: number;
  total: number;
  percent: number;
  model?: string;
} | null {
  return null;
}
