/**
 * History helpers for Cursor. The CLI keeps per-project history
 * under `~/.cursor/projects/<cwd-hash>/*.jsonl` — same shape Codex
 * uses, so the resolver mirrors codex/history.ts.
 *
 * Real fixture-based parser tests for Cursor's exact JSONL schema
 * will land alongside the contract suite (#62); for now we share the
 * shared NormalizedMessage shape so the rest of the pipeline (mobile
 * feed, usage display) works against whatever Cursor emits.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { NormalizedMessage } from '@codeam/shared';

const HISTORY_ROOT = path.join(os.homedir(), '.cursor', 'projects');

export function resolveHistoryDir(cwd: string): string | null {
  // Cursor mirrors Codex's per-cwd subdir layout (hashed path under
  // ~/.cursor/projects). We don't compute the hash here — the
  // mobile feed only needs the agent's chosen file, surfaced via
  // listJsonl-style probes that the runtime fronts.
  if (!fs.existsSync(HISTORY_ROOT)) return null;
  // Defer the per-cwd resolution to a follow-up once we have a real
  // Cursor install to read against. For now return the root so the
  // generic JSONL probe still finds something.
  void cwd;
  return HISTORY_ROOT;
}

/**
 * Stub parser. Returns an empty array until we have a captured
 * fixture from a real Cursor install — until then the mobile feed
 * just won't show Cursor session history, which is the documented
 * behaviour for `enabled: false` agents.
 */
export function parseHistoryFile(_filePath: string): NormalizedMessage[] {
  return [];
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
