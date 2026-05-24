/**
 * Aider history helpers. Aider writes per-session chat history to
 * `.aider.chat.history.md` in the working directory (one file per
 * cwd, not per project). The resolver returns the directory holding
 * it so the mobile feed can locate the active session's transcript.
 *
 * Fixture-driven parser tests are a follow-up — for now the parser
 * returns an empty array (mobile session-detail view still works via
 * SSE; the history backfill just isn't populated until the flag flips).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { NormalizedMessage } from '@codeagent/shared';

const AIDER_HISTORY_FILE = '.aider.chat.history.md';

export function resolveHistoryDir(cwd: string): string | null {
  const candidate = path.join(cwd, AIDER_HISTORY_FILE);
  return fs.existsSync(candidate) ? cwd : null;
}

export function parseHistoryFile(_filePath: string): NormalizedMessage[] {
  // Aider's history format is markdown with `#### user:` / `#### assistant:`
  // headers. Parser is a follow-up — return empty for now so the mobile
  // feed shows no backfill (matching the behaviour for any agent without
  // a fixture-validated parser).
  return [];
}

export function getCurrentUsage(_historyDir: string): {
  used: number;
  total: number;
  percent: number;
  model?: string;
} | null {
  // Aider doesn't expose a usage RPC — token counts are per-message
  // and aggregated only in the live UI. Returning null surfaces "—"
  // in the mobile usage strip, matching Codex.
  return null;
}
