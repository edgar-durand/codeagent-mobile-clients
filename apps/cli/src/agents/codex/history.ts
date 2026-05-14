import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { NormalizedMessage } from '@codeagent/shared';

/**
 * Codex stores conversation history in a SINGLE global JSONL file at
 * `~/.codex/history.jsonl` — not per-cwd like Claude. Records have the shape
 * `{session_id, ts, text}` with no role or token data. We map every line to a
 * NormalizedMessage with role='user' (Codex doesn't differentiate roles in
 * this log; full session transcripts live elsewhere in its rollout files,
 * which we don't consume in Phase 2).
 */
export function resolveHistoryDir(_cwd: string, homeOverride?: string): string | null {
  const home = homeOverride ?? os.homedir();
  const codexDir = path.join(home, '.codex');
  if (!fs.existsSync(path.join(codexDir, 'history.jsonl'))) return null;
  return codexDir;
}

interface CodexHistoryRecord {
  session_id: string;
  ts: number;
  text: string;
}

function isCodexRecord(v: unknown): v is CodexHistoryRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.session_id === 'string' &&
    typeof r.ts === 'number' &&
    typeof r.text === 'string'
  );
}

export function parseHistoryFile(filePath: string): NormalizedMessage[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const out: NormalizedMessage[] = [];
  let idx = 0;
  for (const line of raw.split('\n').filter(Boolean)) {
    let rec: unknown;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!isCodexRecord(rec)) continue;
    out.push({
      id: `${rec.session_id}:${idx}`,
      role: 'user',
      text: rec.text,
      timestamp: new Date(rec.ts * 1000).toISOString(),
    });
    idx++;
  }
  return out;
}

/**
 * Codex history.jsonl has no per-message token data. Return null so the
 * relay omits context-fill % for Codex sessions (mobile handles null
 * gracefully). A future integration with Codex's rate-limit RPC could
 * populate this.
 */
export function getCurrentUsage(_historyDir: string): null {
  return null;
}
