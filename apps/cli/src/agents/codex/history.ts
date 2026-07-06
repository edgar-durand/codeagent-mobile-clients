import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { NormalizedMessage } from '@codeam/shared';

/**
 * Codex stores rich session transcripts as JSONL "rollouts" under
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<TIMESTAMP>-<UUID>.jsonl`.
 * Each rollout file contains the full conversation: session_meta header,
 * response_item records (Message/ToolCall/Reasoning/...), event_msg
 * records (TokenCount/rate_limits/...), and turn_context updates.
 *
 * We only emit the Message records to the mobile feed (with proper
 * user/assistant roles) and aggregate tokens from the latest TokenCount
 * event. Tool calls + reasoning are skipped — they're internal turns
 * that don't belong in a chat-style transcript.
 *
 * The OLDER `~/.codex/history.jsonl` global log (user prompts only, no
 * roles, no tokens) is NOT consumed — it was the v1 path that left agent
 * replies invisible to the mobile UI.
 */

export function resolveHistoryDir(_cwd: string, homeOverride?: string): string | null {
  const home = homeOverride ?? os.homedir();
  const sessionsRoot = path.join(home, '.codex', 'sessions');
  if (!fs.existsSync(sessionsRoot)) return null;

  // Today's date bucket: YYYY/MM/DD.
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const todayDir = path.join(sessionsRoot, yyyy, mm, dd);
  if (!fs.existsSync(todayDir)) return null;
  return todayDir;
}

interface RolloutLine {
  timestamp: string;
  type: 'session_meta' | 'response_item' | 'compacted' | 'turn_context' | 'event_msg';
  payload: unknown;
}

interface SessionMetaPayload {
  id?: string;
  cwd?: string;
  timestamp?: string;
}

interface MessageVariant {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
}

interface ResponseItemPayloadWithMessage {
  Message?: MessageVariant;
  // other variants ignored
}

interface TokenCountPayload {
  TokenCount?: {
    info?: {
      total_token_usage?: { total_tokens?: number };
      model_context_window?: number;
    };
  };
}

function parseLine(line: string): RolloutLine | null {
  try {
    const parsed = JSON.parse(line);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { timestamp?: unknown }).timestamp === 'string' &&
      typeof (parsed as { type?: unknown }).type === 'string'
    ) {
      return parsed as RolloutLine;
    }
  } catch {
    /* swallow malformed lines */
  }
  return null;
}

function extractMessageText(content: MessageVariant['content']): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (typeof block.text === 'string' && block.text.length > 0) {
      // Codex variants for text: input_text, output_text. Accept either.
      if (block.type === 'input_text' || block.type === 'output_text') {
        parts.push(block.text);
      }
    }
  }
  return parts.join('\n');
}

function mapRole(codexRole: string | undefined): NormalizedMessage['role'] {
  if (codexRole === 'user') return 'user';
  if (codexRole === 'assistant') return 'agent';
  return 'system';
}

/**
 * Parse a Codex rollout JSONL file → NormalizedMessage[].
 *
 * Filters: if the file's session_meta records a cwd that doesn't match the
 * current process cwd, returns []. That avoids picking up a concurrent
 * Codex session in a different directory (both files live in the same
 * date bucket).
 */
export function parseHistoryFile(filePath: string): NormalizedMessage[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').filter(Boolean);

  // First pass: find session_meta and verify cwd.
  for (const line of lines) {
    const rec = parseLine(line);
    if (!rec) continue;
    if (rec.type === 'session_meta') {
      const meta = rec.payload as SessionMetaPayload | undefined;
      if (meta && typeof meta.cwd === 'string') {
        // Use realpathSync so macOS symlinks (/var → /private/var) don't
        // cause false mismatches between the stored cwd and process.cwd().
        let resolvedMeta: string;
        let resolvedCurrent: string;
        try {
          resolvedMeta = fs.realpathSync(meta.cwd);
          resolvedCurrent = fs.realpathSync(process.cwd());
        } catch {
          // If either path no longer exists, fall back to simple resolve.
          resolvedMeta = path.resolve(meta.cwd);
          resolvedCurrent = path.resolve(process.cwd());
        }
        if (resolvedMeta !== resolvedCurrent) {
          return [];
        }
      }
      break;
    }
  }

  // Second pass: emit Message records as NormalizedMessage[].
  const out: NormalizedMessage[] = [];
  let idx = 0;
  for (const line of lines) {
    const rec = parseLine(line);
    if (!rec) continue;
    if (rec.type !== 'response_item') continue;
    const payload = rec.payload as ResponseItemPayloadWithMessage | undefined;
    const msg = payload?.Message;
    if (!msg) continue;
    const text = extractMessageText(msg.content);
    if (!text) continue;
    out.push({
      id: `rollout:${idx}`,
      role: mapRole(msg.role),
      text,
      timestamp: rec.timestamp,
    });
    idx++;
  }
  return out;
}

/**
 * Enumerate Codex rollouts for the given cwd as resumable sessions.
 * Walks the last 7 days of date buckets under `~/.codex/sessions/`,
 * picks each rollout whose `session_meta.cwd` matches the current
 * cwd, and emits one row per rollout:
 *
 *   - `id`: the rollout's session_meta.id (Codex's resume token)
 *   - `summary`: the first user message text (trimmed to 120 chars)
 *   - `timestamp`: the file's mtime in ms
 *
 * Returns `[]` when the sessions root doesn't exist (first-ever
 * Codex pair) — same convention as `resolveHistoryDir`. Reads are
 * defensive: any per-file error skips that rollout but keeps the
 * rest.
 *
 * 7 days is a deliberate cap. Codex's daily buckets accumulate
 * indefinitely; scanning every day on every push wastes I/O without
 * meaningful UI benefit (the Conversations sheet shows the most
 * recent sessions anyway). If a user has older rollouts they want
 * to resume, the Codex CLI's own `codex resume` still works.
 */
export function listResumableSessions(
  cwd: string,
  homeOverride?: string,
): Array<{ id: string; summary: string; timestamp: number }> {
  const home = homeOverride ?? os.homedir();
  const sessionsRoot = path.join(home, '.codex', 'sessions');
  if (!fs.existsSync(sessionsRoot)) return [];

  let resolvedCurrent: string;
  try {
    resolvedCurrent = fs.realpathSync(cwd);
  } catch {
    resolvedCurrent = path.resolve(cwd);
  }

  const out: Array<{ id: string; summary: string; timestamp: number }> = [];
  const now = new Date();
  for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
    const d = new Date(now.getTime() - dayOffset * 24 * 60 * 60 * 1000);
    const yyyy = String(d.getUTCFullYear());
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const dayDir = path.join(sessionsRoot, yyyy, mm, dd);
    if (!fs.existsSync(dayDir)) continue;
    let dayFiles: fs.Dirent[];
    try {
      dayFiles = fs.readdirSync(dayDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of dayFiles) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) {
        continue;
      }
      const filePath = path.join(dayDir, entry.name);
      let timestamp = Date.now();
      try {
        timestamp = fs.statSync(filePath).mtimeMs;
      } catch {
        /* keep default */
      }

      let metaCwd: string | undefined;
      let metaId: string | undefined;
      let summary = '';
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          const rec = parseLine(line);
          if (!rec) continue;
          if (rec.type === 'session_meta') {
            const meta = rec.payload as SessionMetaPayload | undefined;
            metaCwd = typeof meta?.cwd === 'string' ? meta.cwd : undefined;
            metaId = typeof meta?.id === 'string' ? meta.id : undefined;
            continue;
          }
          if (!summary && rec.type === 'response_item') {
            const payload = rec.payload as
              | ResponseItemPayloadWithMessage
              | undefined;
            const msg = payload?.Message;
            if (msg && msg.role === 'user') {
              const text = extractMessageText(msg.content).trim();
              if (text) summary = text.slice(0, 120);
            }
          }
          if (metaCwd !== undefined && summary) break;
        }
      } catch {
        continue;
      }
      if (!metaCwd || !metaId || !summary) continue;
      // realpath + resolve to normalise macOS symlink prefixes (/var
      // ↔ /private/var) before comparing — same dance parseHistoryFile
      // does for the body-fetch path.
      let resolvedMeta: string;
      try {
        resolvedMeta = fs.realpathSync(metaCwd);
      } catch {
        resolvedMeta = path.resolve(metaCwd);
      }
      if (resolvedMeta !== resolvedCurrent) continue;
      out.push({ id: metaId, summary, timestamp });
    }
  }
  out.sort((a, b) => b.timestamp - a.timestamp);
  return out;
}

/**
 * Resolve the rollout file for a given Codex session id, or null.
 *
 * `HistoryService` keys a conversation by its session id (Codex's
 * `session_meta.id`), but Codex names the file `rollout-<ts>-<uuid>.jsonl`
 * and stores the id INSIDE — so the Claude `<dir>/<id>.jsonl` layout can't
 * find it (the resume-shows-nothing bug). Walk the same 7-day window
 * {@link listResumableSessions} uses and return the first rollout whose
 * `session_meta.id` matches AND whose `session_meta.cwd` matches the
 * current project, so a same-id collision across projects can't leak.
 */
export function resolveHistoryFile(
  cwd: string,
  sessionId: string,
  homeOverride?: string,
): string | null {
  const home = homeOverride ?? os.homedir();
  const sessionsRoot = path.join(home, '.codex', 'sessions');
  if (!fs.existsSync(sessionsRoot)) return null;

  let resolvedCurrent: string;
  try {
    resolvedCurrent = fs.realpathSync(cwd);
  } catch {
    resolvedCurrent = path.resolve(cwd);
  }

  const now = new Date();
  for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
    const d = new Date(now.getTime() - dayOffset * 24 * 60 * 60 * 1000);
    const yyyy = String(d.getUTCFullYear());
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const dayDir = path.join(sessionsRoot, yyyy, mm, dd);
    if (!fs.existsSync(dayDir)) continue;
    let dayFiles: fs.Dirent[];
    try {
      dayFiles = fs.readdirSync(dayDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of dayFiles) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue;
      const filePath = path.join(dayDir, entry.name);
      let metaCwd: string | undefined;
      let metaId: string | undefined;
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          const rec = parseLine(line);
          if (!rec) continue;
          if (rec.type === 'session_meta') {
            const meta = rec.payload as SessionMetaPayload | undefined;
            metaCwd = typeof meta?.cwd === 'string' ? meta.cwd : undefined;
            metaId = typeof meta?.id === 'string' ? meta.id : undefined;
            break; // session_meta leads the rollout; nothing else to read
          }
        }
      } catch {
        continue;
      }
      if (metaId !== sessionId || !metaCwd) continue;
      let resolvedMeta: string;
      try {
        resolvedMeta = fs.realpathSync(metaCwd);
      } catch {
        resolvedMeta = path.resolve(metaCwd);
      }
      if (resolvedMeta === resolvedCurrent) return filePath;
    }
  }
  return null;
}

/**
 * Aggregated token usage for the most recent rollout in the given dir.
 * Returns null if no rollout files or no TokenCount events found.
 */
export function getCurrentUsage(historyDir: string): {
  used: number;
  total: number;
  percent: number;
  model?: string;
} | null {
  if (!fs.existsSync(historyDir)) return null;
  const files = fs
    .readdirSync(historyDir)
    .filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl'))
    .map((f) => ({ name: f, full: path.join(historyDir, f) }))
    .map((e) => ({ ...e, mtime: fs.statSync(e.full).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) return null;

  const latest = files[0].full;
  const raw = fs.readFileSync(latest, 'utf8');
  let lastTokenCount: { total: number; window: number } | null = null;
  for (const line of raw.split('\n').filter(Boolean)) {
    const rec = parseLine(line);
    if (!rec || rec.type !== 'event_msg') continue;
    const payload = rec.payload as TokenCountPayload | undefined;
    const info = payload?.TokenCount?.info;
    const total = info?.total_token_usage?.total_tokens;
    const window = info?.model_context_window;
    if (typeof total === 'number' && typeof window === 'number' && window > 0) {
      lastTokenCount = { total, window };
    }
  }
  if (!lastTokenCount) return null;

  const used = lastTokenCount.total;
  const total = lastTokenCount.window;
  return {
    used,
    total,
    percent: Math.min(100, Math.round((used / total) * 100)),
  };
}
