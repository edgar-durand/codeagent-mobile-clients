import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { NormalizedMessage } from '@codeagent/shared';

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
