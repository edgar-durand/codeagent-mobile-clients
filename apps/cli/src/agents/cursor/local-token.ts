/**
 * Local Cursor credential extraction for `codeam link cursor`.
 *
 * Cursor's CLI stores OAuth credentials at `~/.cursor/auth.json` on
 * every platform (no macOS Keychain hop, no Windows-specific path).
 * Matches the codex layout — keep them aligned in case Cursor adds
 * an XDG fallback later (we'd add it to both at once).
 *
 * Note: the exact file path + format here is best-effort based on
 * Cursor's documented `cursor-agent` install layout. Real captured
 * tokens will need a smoke pass against a paid Cursor account
 * before AGENT_REGISTRY.cursor.enabled flips to true.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LocalAgentToken } from '../strategy';

export function cursorCredentialsPath(): string {
  return path.join(os.homedir(), '.cursor', 'auth.json');
}

export async function extractLocalCursorToken(): Promise<LocalAgentToken | null> {
  const file = cursorCredentialsPath();
  if (!fs.existsSync(file)) return null;
  const credential = fs.readFileSync(file, 'utf8').trim();
  if (credential.length === 0) return null;
  return { method: 'oauth', credential, source: 'flat-file' };
}

export function cursorCredentialsPaths(): string[] {
  return [cursorCredentialsPath()];
}
