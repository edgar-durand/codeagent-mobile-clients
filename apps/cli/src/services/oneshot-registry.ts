import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Conversation ids of the headless one-shots (`claude -p` for preview detect,
 * AI summary/insights) run in a workspace. They share the session's cwd +
 * config dir, so their `<id>.jsonl` lands in the session's project dir and
 * posed as the user's conversation: RECENT rows titled "Analyze the project…",
 * `detectCurrentConversation` picking them, the legacy resume loading them
 * (prod QA box, 2026-09-29). Readers skip these ids.
 *
 * Machine state, keyed like the active-conversation marker
 * (`~/.codeam/oneshot-conversations/<sha(cwd)>.json`); bounded; best-effort —
 * a lost registry only brings back the cosmetic rows.
 */
const MAX_IDS = 100;

function registryPath(cwd: string, homeDir: string = os.homedir()): string {
  const key = createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
  return path.join(homeDir, '.codeam', 'oneshot-conversations', `${key}.json`);
}

function readIds(cwd: string, homeDir?: string): string[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(registryPath(cwd, homeDir), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || !('ids' in parsed)) return [];
    const { ids } = parsed;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function registerOneShotConversation(cwd: string, id: string, homeDir?: string): void {
  try {
    const ids = [...readIds(cwd, homeDir).filter((x) => x !== id), id].slice(-MAX_IDS);
    const file = registryPath(cwd, homeDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ids }) + '\n', 'utf8');
  } catch {
    /* best-effort */
  }
}

export function readOneShotConversations(cwd: string, homeDir?: string): Set<string> {
  return new Set(readIds(cwd, homeDir));
}

export function isOneShotConversation(cwd: string, id: string, homeDir?: string): boolean {
  return readIds(cwd, homeDir).includes(id);
}
