/**
 * Local opencode credential extraction for `codeam link opencode`.
 *
 * opencode stores its multi-provider login state at
 * `~/.local/share/opencode/auth.json` (written by `opencode auth login`), on
 * every platform (XDG data dir; no Keychain hop). Same flat-file shape as
 * cursor/codex — capture the whole blob verbatim; the deploy provisioner writes
 * it back to the same path.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LocalAgentToken } from '../strategy';

export function opencodeCredentialsPath(): string {
  const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdgData, 'opencode', 'auth.json');
}

export async function extractLocalOpencodeToken(): Promise<LocalAgentToken | null> {
  const file = opencodeCredentialsPath();
  if (!fs.existsSync(file)) return null;
  const credential = fs.readFileSync(file, 'utf8').trim();
  if (credential.length === 0) return null;
  return { method: 'oauth', credential, source: 'flat-file' };
}

export function opencodeCredentialsPaths(): string[] {
  return [opencodeCredentialsPath()];
}
