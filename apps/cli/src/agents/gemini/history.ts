/**
 * History helpers for Gemini CLI.
 *
 * `gemini` records a per-session transcript at
 *   `~/.gemini/tmp/<projectName>/chats/session-<ts>-<sessionId8>.jsonl`
 * where `<projectName>` is the value `~/.gemini/projects.json` maps the cwd to
 * (default: the cwd basename). We spawn the native TUI with a pre-minted
 * `--session-id <uuid>` (see gemini/runtime.ts `prepareLaunch`), so the file's
 * first-line header carries our id and the filename embeds `sessionId[0:8]`.
 *
 * File shape (reverse-engineered from a real Gemini 0.45 install, 2026-07-08):
 *   line 1  header: {sessionId, projectHash, startTime, lastUpdated, kind}
 *   `$set`  snapshot ops: {"$set":{messages:[{id,type,content,…}]}} — the
 *           bootstrap `$set` seeds a synthetic `<session_context>` user turn.
 *   record  {id, timestamp, type:'user'|'gemini', content} — the real turns.
 * `content` is either an array of `{text}` parts, a stringified such array, or a
 * plain string (gemini replies). Messages carry a stable `id`, so we dedup
 * across the `$set` snapshots and the standalone records by id.
 *
 * Powers the baton read-only mirror (LOCAL_DRIVE) + the mobile session feed.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { NormalizedMessage } from '@codeam/shared';

const GEMINI_ROOT = path.join(os.homedir(), '.gemini');

interface ProjectsFile {
  projects?: Record<string, string>;
}

/** Map a cwd to gemini's project name (`~/.gemini/projects.json`), falling back
 *  to the cwd basename — gemini's own default when the map has no entry. */
function projectNameForCwd(cwd: string, root: string): string | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(root, 'projects.json'), 'utf8'),
    ) as ProjectsFile;
    const map = parsed.projects;
    if (map && typeof map === 'object') {
      if (typeof map[cwd] === 'string') return map[cwd];
      try {
        const rp = fs.realpathSync(cwd);
        if (typeof map[rp] === 'string') return map[rp];
      } catch {
        /* cwd may not exist — fall through to basename */
      }
    }
  } catch {
    /* no projects.json yet — fall through to basename */
  }
  return path.basename(cwd) || null;
}

export function resolveHistoryDir(cwd: string, root: string = GEMINI_ROOT): string | null {
  const name = projectNameForCwd(cwd, root);
  if (!name) return null;
  const dir = path.join(root, 'tmp', name, 'chats');
  return fs.existsSync(dir) ? dir : null;
}

/**
 * Resolve the transcript for a session id. Prefers the file whose name embeds
 * `sessionId[0:8]`, then a first-line header match, then the most-recently
 * modified chats file (the live session) as a safety net for the baton — the
 * session we just launched is always the newest.
 */
export function resolveHistoryFile(
  cwd: string,
  sessionId: string,
  root: string = GEMINI_ROOT,
): string | null {
  const dir = resolveHistoryDir(cwd, root);
  if (!dir) return null;
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith('session-') && f.endsWith('.jsonl'));
  } catch {
    return null;
  }
  if (files.length === 0) return null;

  const id8 = sessionId.slice(0, 8);
  const byName = files.find((f) => id8.length > 0 && f.includes(id8));
  if (byName) return path.join(dir, byName);

  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const firstLine = fs.readFileSync(full, 'utf8').split('\n', 1)[0] ?? '';
      const hdr = JSON.parse(firstLine) as { sessionId?: unknown };
      if (hdr.sessionId === sessionId) return full;
    } catch {
      /* unreadable / non-JSON header — skip */
    }
  }

  let newest: { file: string; mtime: number } | null = null;
  for (const f of files) {
    try {
      const mtime = fs.statSync(path.join(dir, f)).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { file: f, mtime };
    } catch {
      /* skip */
    }
  }
  return newest ? path.join(dir, newest.file) : null;
}

interface GeminiTextPart {
  text?: unknown;
}
interface GeminiMessage {
  id?: unknown;
  type?: unknown;
  content?: unknown;
  timestamp?: unknown;
}
interface GeminiLine {
  $set?: { messages?: unknown };
  type?: unknown;
}

/** Pull display text from gemini's `content`: an array of `{text}` parts, a
 *  stringified such array, or a plain string (replies). */
function extractGeminiText(content: unknown): string {
  const fromParts = (arr: unknown): string | null =>
    Array.isArray(arr)
      ? arr
          .map((p) => {
            const part = p as GeminiTextPart;
            return typeof part?.text === 'string' ? part.text : '';
          })
          .join('')
      : null;

  const parts = fromParts(content);
  if (parts !== null) return parts;
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (trimmed.startsWith('[')) {
      try {
        const asParts = fromParts(JSON.parse(trimmed));
        if (asParts !== null) return asParts;
      } catch {
        /* not JSON — use verbatim */
      }
    }
    return content;
  }
  return '';
}

/** Gemini seeds the chat with a synthetic `<session_context>` user turn — filter
 *  it so the phone shows the real conversation, not the CLI's context envelope. */
function isSyntheticGeminiTurn(text: string): boolean {
  return text.trim().startsWith('<session_context>');
}

export function parseHistoryFile(filePath: string): NormalizedMessage[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const out: NormalizedMessage[] = [];
  const seen = new Set<string>();
  let idx = 0;

  const consider = (m: GeminiMessage): void => {
    if (m.type !== 'user' && m.type !== 'gemini') return;
    const id = typeof m.id === 'string' ? m.id : `pos-${idx}`;
    if (seen.has(id)) return;
    const text = extractGeminiText(m.content);
    if (!text || isSyntheticGeminiTurn(text)) return;
    seen.add(id);
    out.push({
      id: `gemini:${id}`,
      role: m.type === 'user' ? 'user' : 'agent',
      text,
      timestamp: typeof m.timestamp === 'string' ? m.timestamp : new Date(0).toISOString(),
    });
    idx += 1;
  };

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec: GeminiLine;
    try {
      rec = JSON.parse(line) as GeminiLine;
    } catch {
      continue;
    }
    if (rec.$set && Array.isArray(rec.$set.messages)) {
      for (const m of rec.$set.messages) consider(m as GeminiMessage);
    } else if (rec.type === 'user' || rec.type === 'gemini') {
      consider(rec as GeminiMessage);
    }
    // header line + non-message `$set` ops are ignored.
  }
  return out;
}

/** Quota / usage stub — gemini exposes usage via its own API, not the CLI. */
export function getCurrentUsage(_historyDir: string): {
  used: number;
  total: number;
  percent: number;
  model?: string;
} | null {
  return null;
}
