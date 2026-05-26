/**
 * Local Claude credential extraction for `codeam link claude`.
 *
 * Sibling of `credentials.ts` (which bridges the same token UP to a
 * remote codespace). This file extracts the token DOWN to a local
 * string so the CLI can POST it to /api/plugin/agents/:agentId/link.
 *
 * Probe order (first hit wins):
 *
 *   1. `~/.claude/.credentials.json`         (Linux default + custom-build macOS)
 *   2. `~/.config/claude/.credentials.json`  (XDG-style fallback)
 *   3. macOS Keychain entries — each known service name tried in turn.
 *      Anthropic has renamed this entry between Claude Code releases,
 *      so we probe every name we've seen in the wild rather than
 *      hard-coding one and silently returning "no creds" on rename.
 *
 * The returned `credential` string is the FULL JSON blob the agent
 * wrote — same bytes `codeam deploy` ships into the codespace, same
 * bytes the install snippet reads back. We never parse it; the vault
 * stores it opaque.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// Hoisted to `agents/strategy.ts` so both per-agent link strategies
// and the link command can import a single canonical type. Re-exported
// here for callers that grew up on the old import path.
export type { LocalAgentToken } from '../strategy';
import type { LocalAgentToken } from '../strategy';

/**
 * Every Keychain service name we've observed for the Claude Code OAuth
 * blob, in priority order. Newer builds keep coming back to
 * "Claude Code-credentials" but we keep the older aliases around so a
 * machine that's been on every release since v1.x still resolves.
 */
const KEYCHAIN_SERVICE_NAMES = [
  'Claude Code-credentials',
  'claude-code-credentials',
  'Claude',
  'Anthropic Claude',
];

/**
 * Filesystem locations where Claude Code may write its credentials
 * JSON blob. Tried in order; the first non-empty file wins.
 */
export function claudeCredentialsPaths(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.claude', '.credentials.json'),
    path.join(home, '.config', 'claude', '.credentials.json'),
  ];
}

/**
 * Read the local Claude credentials and return them as a token blob.
 * Returns `null` when no probe yields a credential at any known
 * location. The caller (`codeam link`) treats `null` as "user is not
 * yet authenticated locally" and starts the interactive login flow.
 *
 * Also captures `~/.claude.json` (UI state + `oauthAccount` identity
 * block) when present. The backend ships that file into the codespace
 * at deploy time so Claude Code v2.x can validate the OAuth token
 * against the same email/orgId the user has locally — without it the
 * bearer token gets rejected with 401 even when the JSON is fresh.
 */
export async function extractLocalClaudeToken(): Promise<LocalAgentToken | null> {
  const agentState = readClaudeAgentState();

  for (const flat of claudeCredentialsPaths()) {
    if (!fs.existsSync(flat)) continue;
    const credential = fs.readFileSync(flat, 'utf8').trim();
    if (credential.length > 0) {
      return { method: 'oauth', credential, source: 'flat-file', agentState };
    }
  }

  if (process.platform === 'darwin') {
    for (const service of KEYCHAIN_SERVICE_NAMES) {
      try {
        const { stdout } = await execFileP(
          'security',
          ['find-generic-password', '-s', service, '-w'],
          { maxBuffer: 1024 * 1024 },
        );
        const credential = stdout.trim();
        if (credential.length > 0) {
          return { method: 'oauth', credential, source: 'macos-keychain', agentState };
        }
      } catch {
        /* entry missing / access denied — try next service name */
      }
    }
  }

  return null;
}

/**
 * Read the user's `~/.claude.json` if present. Returns `undefined`
 * when the file is missing, empty, or unreadable — never throws,
 * because failing to capture the companion state should NEVER block
 * a credential link (the backend handles missing state with the
 * minimal synthesised fallback).
 *
 * Hard 256 KB cap matches the backend DTO limit — anything larger is
 * almost certainly local cache pollution we don't want shipped into
 * the codespace.
 */
function readClaudeAgentState(): string | undefined {
  const STATE_MAX_BYTES = 256 * 1024;
  const candidate = path.join(os.homedir(), '.claude.json');
  try {
    if (!fs.existsSync(candidate)) return undefined;
    const buf = fs.readFileSync(candidate);
    if (buf.length === 0 || buf.length > STATE_MAX_BYTES) return undefined;
    const text = buf.toString('utf8').trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Snapshot the mtime of the first existing local Claude credentials
 * file so the caller can later detect whether `claude login` produced
 * a fresh token. Returns `null` if no file is present (which is the
 * common "user has never logged in" case + the macOS Keychain case).
 */
export function claudeCredentialsMtime(): number | null {
  for (const flat of claudeCredentialsPaths()) {
    try {
      return fs.statSync(flat).mtimeMs;
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Returns `true` if any of the probed credential locations currently
 * resolves to a non-empty string. Convenience around
 * `extractLocalClaudeToken` for use sites that only need a yes/no.
 */
export async function hasLocalClaudeAuth(): Promise<boolean> {
  return (await extractLocalClaudeToken()) !== null;
}
