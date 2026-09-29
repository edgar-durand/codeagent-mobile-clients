import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * "This is the conversation the user was driving in this workspace" — written
 * every time the runner (re)points its live conversation (fresh session,
 * auto-resume, RECENT-sheet resume, agent switch) and read on a host-agent
 * RESUME boot to pick what to load.
 *
 * Why a marker and not "the most recent transcript": one-shots (`claude -p`
 * for the AI summary / preview detect) run in the SAME cwd + config dir and
 * write their own `<id>.jsonl`, so after a Box wake the newest file was the
 * summary one-shot — the session resumed "You just finished a turn… write a
 * 2-3 sentence summary" instead of the user's conversation (QA box,
 * 2026-09-29). Machine state, so it lives OUTSIDE the project
 * (`~/.codeam/conversation-active/<sha(cwd)>.json`, same shape as the preview
 * marker); best-effort throughout — a missing marker means "no preference".
 */
function markerPath(cwd: string, homeDir: string = os.homedir()): string {
  const key = createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
  return path.join(homeDir, '.codeam', 'conversation-active', `${key}.json`);
}

export async function writeActiveConversationMarker(
  cwd: string,
  conversationId: string,
  homeDir?: string,
): Promise<void> {
  try {
    const file = markerPath(cwd, homeDir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({ conversationId, at: new Date().toISOString() }, null, 2) + '\n',
      'utf8',
    );
  } catch {
    /* best-effort */
  }
}

export async function readActiveConversationMarker(
  cwd: string,
  homeDir?: string,
): Promise<string | null> {
  try {
    const raw = await fs.readFile(markerPath(cwd, homeDir), 'utf8');
    const parsed = JSON.parse(raw) as { conversationId?: unknown };
    return typeof parsed.conversationId === 'string' && parsed.conversationId
      ? parsed.conversationId
      : null;
  } catch {
    return null;
  }
}
