/**
 * History helpers for Kimi Code CLI (Moonshot) — powers the baton read-only
 * mirror (LOCAL_DRIVE) + the mobile session feed, exactly like Cursor's.
 *
 * `kimi` records a per-session transcript at
 *   `<KIMI_CODE_HOME>/sessions/wd_<basename>_<sha256(cwd)[:12]>/<sessionId>/agents/main/wire.jsonl`
 * (KIMI_CODE_HOME defaults to `~/.kimi-code`). `<sessionId>` is kimi's own
 * `session_<uuid>` (the id ACP `session/new` returns). The `wire.jsonl` is an
 * append-only event log — reverse-engineered from a real kimi-code 0.23.3 box
 * (2026-07-09):
 *   {"type":"metadata",...} / {"type":"config.update",...}      ← preamble, skipped
 *   {"type":"turn.prompt","input":[{"type":"text","text":…}]}   ← a USER turn
 *   {"type":"context.append_loop_event","event":{"type":"content.part",
 *      "part":{"type":"text","text":…}}}                        ← ASSISTANT reply text
 *      (part.type "think" / tool.call / tool.result are internals — skipped)
 *
 * Everything here is Kimi-specific and lives in the Kimi strategy — it never
 * touches shared baton code or any other agent.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { NormalizedMessage } from '@codeam/shared';
import { log } from '../../services/logger';

/** Kimi's data root — override with KIMI_CODE_HOME, else `~/.kimi-code`. */
function kimiHome(): string {
  return process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
}

/** kimi's per-cwd session bucket: `wd_<basename>_<first-12-hex sha256(cwd)>`
 *  (verified live: sha256("/workspaces/privacyhawk_webapp")[:12] matched the
 *  observed `wd_privacyhawk_webapp_2956518bcd0b`). */
function workDirKey(cwd: string): string {
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 12);
  return `wd_${path.basename(cwd)}_${hash}`;
}

export function resolveHistoryDir(cwd: string): string | null {
  const dir = path.join(kimiHome(), 'sessions', workDirKey(cwd));
  if (!fs.existsSync(dir)) {
    // Normal before the TUI's first turn — the mirror bounded-polls, so this is
    // expected transiently. Debug, not warn.
    log.debug('kimi', `resolveHistoryDir — session bucket not present yet: ${dir}`);
    return null;
  }
  return dir;
}

/** The one relative path a kimi session's transcript always lives at. */
const WIRE_REL = path.join('agents', 'main', 'wire.jsonl');

/**
 * Resolve the `wire.jsonl` for a specific `sessionId`. kimi maintains a
 * `session_index.jsonl` mapping sessionId → sessionDir, so we consult that FIRST
 * (authoritative, encoding-independent); fall back to the computed cwd bucket,
 * then to a scan of every `wd_*` bucket (sessionId is globally unique — the same
 * robustness Cursor's resolver uses for its encoded-cwd dirs).
 */
export function resolveHistoryFile(cwd: string, sessionId: string): string | null {
  // 1) session_index.jsonl → the exact sessionDir kimi recorded.
  const fromIndex = sessionDirFromIndex(sessionId);
  if (fromIndex) {
    const p = path.join(fromIndex, WIRE_REL);
    if (fs.existsSync(p)) return p;
  }
  // 2) Computed cwd bucket.
  const bucket = path.join(kimiHome(), 'sessions', workDirKey(cwd));
  const computed = path.join(bucket, sessionId, WIRE_REL);
  if (fs.existsSync(computed)) return computed;
  // 3) Scan every wd_* bucket for <sessionId>/agents/main/wire.jsonl.
  const scanned = scanBucketsForSession(sessionId);
  if (scanned) return scanned;
  return null;
}

function sessionDirFromIndex(sessionId: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(kimiHome(), 'session_index.jsonl'), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.includes(sessionId)) continue;
      try {
        const rec = JSON.parse(line) as { sessionId?: string; sessionDir?: string };
        if (rec.sessionId === sessionId && typeof rec.sessionDir === 'string') {
          return rec.sessionDir;
        }
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    /* no index yet — fall through */
  }
  return null;
}

function scanBucketsForSession(sessionId: string): string | null {
  const sessionsRoot = path.join(kimiHome(), 'sessions');
  let buckets: fs.Dirent[];
  try {
    buckets = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const b of buckets) {
    if (!b.isDirectory()) continue;
    const candidate = path.join(sessionsRoot, b.name, sessionId, WIRE_REL);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

interface WirePart {
  type?: string;
  text?: string;
}
interface WireEvent {
  type?: string;
  time?: number;
  input?: WirePart[];
  event?: { type?: string; part?: WirePart };
}

function joinTextParts(parts: WirePart[] | undefined): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('')
    .trim();
}

/**
 * Parse `wire.jsonl` into an ordered user/agent transcript. USER turns come from
 * `turn.prompt`; ASSISTANT text is accumulated from `content.part` events whose
 * `part.type === 'text'` (think / tool-call / tool-result parts are internals we
 * skip) and flushed as one message on the next user turn / end of file.
 */
export function parseHistoryFile(filePath: string): NormalizedMessage[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const out: NormalizedMessage[] = [];
  let idx = 0;
  let assistantBuf = '';
  let assistantTime = 0;

  const flushAssistant = (): void => {
    const text = assistantBuf.trim();
    if (text) {
      out.push({
        id: `kimi:${idx}`,
        role: 'agent',
        text,
        timestamp: new Date(assistantTime || 0).toISOString(),
      });
      idx += 1;
    }
    assistantBuf = '';
    assistantTime = 0;
  };

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec: WireEvent;
    try {
      rec = JSON.parse(line) as WireEvent;
    } catch {
      continue;
    }
    if (rec.type === 'turn.prompt') {
      flushAssistant(); // close any pending assistant turn before the new user turn
      const text = joinTextParts(rec.input);
      if (text) {
        out.push({
          id: `kimi:${idx}`,
          role: 'user',
          text,
          timestamp: new Date(rec.time || 0).toISOString(),
        });
        idx += 1;
      }
    } else if (
      rec.type === 'context.append_loop_event' &&
      rec.event?.type === 'content.part' &&
      rec.event.part?.type === 'text' &&
      typeof rec.event.part.text === 'string'
    ) {
      assistantBuf += rec.event.part.text;
      if (!assistantTime) assistantTime = rec.time || 0;
    }
  }
  flushAssistant();
  return out;
}

/** Kimi's usage RPC isn't surfaced through the CLI today; returning null shows
 *  "—" in the mobile UI, matching Cursor/Codex. */
export function getCurrentUsage(
  _historyDir: string,
): { used: number; total: number; percent: number; model?: string } | null {
  return null;
}
