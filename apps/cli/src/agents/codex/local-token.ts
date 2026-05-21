/**
 * Local Codex credential extraction for `codeam link codex`.
 *
 * Codex stores OAuth credentials at `~/.codex/auth.json` on every
 * platform (no Keychain hop, no Windows-specific path). The CLI's
 * existing `bridgeLocalCodexCredentials` for the codespace deploy
 * uses the same file; this is the local read-only analogue used by
 * `codeam link codex` to capture the token and POST it to
 * /api/plugin/agents/codex/link.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LocalAgentToken } from '../claude/local-token';

export function codexCredentialsPath(): string {
  return path.join(os.homedir(), '.codex', 'auth.json');
}

/**
 * Read the local Codex credentials and return them as a token blob.
 * Returns `null` when nothing is found.
 *
 * Note: unlike codex's deploy bridge we do NOT fall back to
 * `OPENAI_API_KEY`. The link flow is specifically about capturing a
 * real Codex login session; pasting an API key has its own UI path
 * in mobile (`ProfileAgentsScreen` → "Paste an API key").
 */
export async function extractLocalCodexToken(): Promise<LocalAgentToken | null> {
  const file = codexCredentialsPath();
  if (!fs.existsSync(file)) return null;
  const credential = fs.readFileSync(file, 'utf8').trim();
  if (credential.length === 0) return null;
  return { method: 'oauth', credential, source: 'flat-file' };
}

export function codexCredentialsMtime(): number | null {
  const file = codexCredentialsPath();
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}
