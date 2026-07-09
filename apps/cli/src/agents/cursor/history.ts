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
import { createHash } from 'node:crypto';
import type { NormalizedMessage } from '@codeam/shared';
import { log } from '../../services/logger';

const HISTORY_ROOT = path.join(os.homedir(), '.cursor', 'projects');

// ─────────────────────────────────────────────────────────────────────────────
// Baton store bridge (native TUI ↔ ACP)
//
// Cursor keeps a conversation in TWO separate SQLite stores depending on how it
// was driven, both under `~/.cursor` (same dir on Windows/macOS/Linux — resolved
// via os.homedir(), never a hardcoded path or separator):
//   • native TUI / `create-chat`:  ~/.cursor/chats/<md5(cwd)>/<id>/store.db
//   • ACP `session/new`:           ~/.cursor/acp-sessions/<id>/store.db (+ meta.json)
// `session/load` reads ONLY the acp-sessions store, so a native session id is
// "not found" there. The two stores share an identical `blobs`+`meta` schema, so
// the baton bridges them with a raw file copy at each hand-off (verified live:
// the copied store replays the full conversation over `session/load`). All of it
// is cursor-internal — the baton engine stays agent-agnostic.
// ─────────────────────────────────────────────────────────────────────────────

const CURSOR_HOME = path.join(os.homedir(), '.cursor');
// store.db is the DB; -wal / -shm are SQLite's write-ahead log + shared-memory
// index. Copying whatever exists lets SQLite recover on next open — no dependency
// on a `sqlite3` binary (which isn't guaranteed on any OS).
const STORE_FILES = ['store.db', 'store.db-wal', 'store.db-shm'];

function acpSessionDir(sessionId: string): string {
  return path.join(CURSOR_HOME, 'acp-sessions', sessionId);
}

/** Locate the native-TUI store dir for a session. Scans `chats/<*>/<id>` first
 *  (robust across OSes — no dependence on how cursor stringifies the cwd before
 *  hashing), falling back to the known `chats/<md5(cwd)>/<id>` layout. */
function nativeStoreDir(cwd: string, sessionId: string): string | null {
  const chatsRoot = path.join(CURSOR_HOME, 'chats');
  let buckets: string[] = [];
  try {
    buckets = fs.readdirSync(chatsRoot);
  } catch {
    /* no chats dir yet */
  }
  for (const b of buckets) {
    const candidate = path.join(chatsRoot, b, sessionId);
    if (fs.existsSync(path.join(candidate, 'store.db'))) return candidate;
  }
  // Fallback for the create-before-first-turn case: the computed bucket.
  const computed = path.join(chatsRoot, createHash('md5').update(cwd).digest('hex'), sessionId);
  return fs.existsSync(computed) ? computed : null;
}

/** Copy the store.db (+ WAL/SHM) from `srcDir` to `dstDir`, replacing any stale
 *  destination store files first so an old WAL can't shadow the fresh DB. Only
 *  the store files are touched — never meta.json (each store owns its own). */
function copyStoreFiles(srcDir: string, dstDir: string): void {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const f of STORE_FILES) {
    const dst = path.join(dstDir, f);
    if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
  }
  for (const f of STORE_FILES) {
    const src = path.join(srcDir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dstDir, f));
  }
}

/** Take Control: mirror the native-TUI conversation into the ACP store so
 *  `session/load(<id>)` finds it. Also writes the minimal acp-sessions meta.json
 *  ({schemaVersion,cwd}) the ACP layer expects. Best-effort — never throws. */
export function bridgeNativeToAcp(cwd: string, sessionId: string): void {
  try {
    const src = nativeStoreDir(cwd, sessionId);
    if (!src) {
      log.warn('cursor', `baton bridge: no native store for ${sessionId.slice(0, 8)} — skip`);
      return;
    }
    const dst = acpSessionDir(sessionId);
    copyStoreFiles(src, dst);
    fs.writeFileSync(
      path.join(dst, 'meta.json'),
      JSON.stringify({ schemaVersion: 1, cwd }),
    );
    log.info('cursor', `baton bridge native→acp ok (${sessionId.slice(0, 8)})`);
  } catch (err) {
    log.warn('cursor', `baton bridge native→acp failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Hand-back: mirror the ACP conversation back into the native store so
 *  `cursor-agent --resume <id>` in the terminal shows mobile's turns. The native
 *  store dir + its own meta.json already exist from the initial local drive; only
 *  the store files are refreshed. Best-effort — never throws. */
export function bridgeAcpToNative(cwd: string, sessionId: string): void {
  try {
    const src = acpSessionDir(sessionId);
    if (!fs.existsSync(path.join(src, 'store.db'))) {
      log.warn('cursor', `baton bridge: no acp store for ${sessionId.slice(0, 8)} — skip`);
      return;
    }
    const dst = nativeStoreDir(cwd, sessionId) ??
      path.join(CURSOR_HOME, 'chats', createHash('md5').update(cwd).digest('hex'), sessionId);
    copyStoreFiles(src, dst);
    log.info('cursor', `baton bridge acp→native ok (${sessionId.slice(0, 8)})`);
  } catch (err) {
    log.warn('cursor', `baton bridge acp→native failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

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
