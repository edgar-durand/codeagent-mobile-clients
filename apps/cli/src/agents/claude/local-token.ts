/**
 * Local Claude credential extraction for `codeam link claude`.
 *
 * Sibling of `credentials.ts` (which bridges the same token UP to a
 * remote codespace). This file extracts the token DOWN to a local
 * string so the CLI can POST it to /api/plugin/agents/:agentId/link.
 *
 * Storage locations (mirror what `claude login` writes):
 *
 *   - Linux  → flat file at `~/.claude/.credentials.json`
 *   - macOS  → macOS Keychain entry `Claude Code-credentials`
 *              (fallback: flat file at `~/.claude/.credentials.json`
 *              for users on a custom build)
 *   - Windows → flat file at `~/.claude/.credentials.json` (Claude
 *               Code on Windows writes here today; if a future build
 *               moves to Windows Credential Manager we'll add a
 *               PowerShell hop here, but for now flat-file is the
 *               only documented Windows path)
 *
 * The returned `credential` string is the FULL JSON blob the agent
 * wrote — same bytes `codeam deploy` ships into the codespace, same
 * bytes the install snippet reads back. We never parse it; vault
 * stores it opaque.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface LocalAgentToken {
  /** Always `'oauth'` for `claude login`'s output. */
  method: 'oauth' | 'api_key';
  /** Opaque token string to seal in the vault. */
  credential: string;
  /** Where we found it — drives the user-facing success message. */
  source: 'flat-file' | 'macos-keychain';
}

export function claudeCredentialsPath(): string {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

/**
 * Read the local Claude credentials and return them as a token blob.
 * Returns `null` when nothing is found — the caller (`codeam link`)
 * uses that to decide whether to re-launch `claude login`.
 */
export async function extractLocalClaudeToken(): Promise<LocalAgentToken | null> {
  const flat = claudeCredentialsPath();
  if (fs.existsSync(flat)) {
    const credential = fs.readFileSync(flat, 'utf8').trim();
    if (credential.length > 0) {
      return { method: 'oauth', credential, source: 'flat-file' };
    }
  }

  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileP(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { maxBuffer: 1024 * 1024 },
      );
      const credential = stdout.trim();
      if (credential.length > 0) {
        return { method: 'oauth', credential, source: 'macos-keychain' };
      }
    } catch {
      /* keychain entry missing → fall through to null */
    }
  }

  return null;
}

/**
 * Snapshot the mtime of the local Claude credentials file so the
 * caller can later detect whether `claude login` produced a fresh
 * token. macOS keychain reads have no mtime — caller falls back to
 * "before vs after content differs" for that path.
 */
export function claudeCredentialsMtime(): number | null {
  const flat = claudeCredentialsPath();
  try {
    return fs.statSync(flat).mtimeMs;
  } catch {
    return null;
  }
}
