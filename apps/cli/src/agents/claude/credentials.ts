import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as p from '@clack/prompts';
import type { CloudProvider } from '../../services/providers/types';
import type { LocalCredentialSource } from '../strategy';

const execFileP = promisify(execFile);

/**
 * Detects local Claude credentials on this machine.
 * Returns the source + a human-friendly description for the prompt.
 *
 *   - Linux  → `~/.claude/.credentials.json` exists?
 *   - macOS  → Keychain has a `Claude Code-credentials` entry? We
 *              probe with the metadata-only form of `security`
 *              (`find-generic-password` without `-w`) so the user
 *              isn't prompted to unlock the keychain just to be
 *              asked the question.
 *   - Windows → Not yet implemented; reports `none`.
 */
export async function detectLocalClaudeCredentials(): Promise<LocalCredentialSource> {
  const localClaudeDir = path.join(os.homedir(), '.claude');
  const flat = path.join(localClaudeDir, '.credentials.json');
  if (fs.existsSync(flat)) {
    return { source: 'flat-file', description: '~/.claude/.credentials.json' };
  }
  if (os.platform() === 'darwin') {
    try {
      // `security find-generic-password -s <service>` (no -w) returns
      // metadata if the entry exists, errors if not. Doesn't expose
      // the secret, doesn't trigger a keychain unlock prompt.
      await execFileP(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials'],
        { maxBuffer: 1024 * 1024 },
      );
      return { source: 'macos-keychain', description: 'macOS Keychain' };
    } catch {
      return { source: 'none', description: '' };
    }
  }
  return { source: 'none', description: '' };
}

/**
 * Extracts local Claude credentials and uploads them to the workspace.
 * Returns the source actually used (so the caller can show the right success message).
 *
 *   - Linux  → credentials live at `~/.claude/.credentials.json` as
 *              a flat file. The tar in `uploadDirectory` already
 *              shipped it; nothing to do here. (Returns `'flat-file'`.)
 *   - macOS  → credentials live in the macOS Keychain under the
 *              service name `Claude Code-credentials`. We pull the
 *              JSON via `security find-generic-password -w` and write
 *              it to `~/.claude/.credentials.json` on the remote
 *              (chmod 600). Same shape Claude Code reads on Linux.
 *   - Windows → credentials live in Windows Credential Manager. We
 *              don't auto-bridge today (would need a PowerShell or
 *              native API hop); the caller falls back to interactive
 *              login. (Returns `'none'`.)
 */
export async function bridgeClaudeCredentials(
  provider: CloudProvider,
  workspaceId: string,
): Promise<LocalCredentialSource> {
  const localClaudeDir = path.join(os.homedir(), '.claude');

  // Case 1 — flat file (Linux's default; also possible on macOS for
  // users on a custom build). The directory tar already shipped it.
  const fileBased = path.join(localClaudeDir, '.credentials.json');
  if (fs.existsSync(fileBased)) {
    return { source: 'flat-file', description: '~/.claude/.credentials.json' };
  }

  // Case 2 — macOS Keychain. Out of process: shell to `security`,
  // pipe the JSON straight into the remote write so it never touches
  // disk on either side.
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileP(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { maxBuffer: 1024 * 1024 },
      );
      const json = stdout.trim();
      if (json.length === 0) return { source: 'none', description: '' };
      await provider.uploadFile(
        workspaceId,
        '/home/codespace/.claude/.credentials.json',
        json,
        { mode: 0o600 },
      );
      return { source: 'macos-keychain', description: 'macOS Keychain' };
    } catch {
      // No entry, denied, or `security` missing — fall through.
      return { source: 'none', description: '' };
    }
  }

  // Case 3 — Windows Credential Manager (or Linux installs that use
  // libsecret instead of the flat file). Bridging from these stores
  // requires native API hops we haven't built yet; the caller will
  // run `claude login` interactively on the remote instead.
  return { source: 'none', description: '' };
}

/**
 * SSH-runs `claude login` interactively on the workspace so the URL
 * the CLI prints (and any code-paste prompt the auth flow asks for)
 * come straight to the user's local terminal.
 *
 * The remote command shape is:
 *   bash -lc "claude login"
 * via the provider's `streamCommand` so PATH from .bashrc / .zshrc /
 * /etc/profile.d / nvm pick up the freshly-installed `claude` binary.
 */
export async function runRemoteClaudeLogin(
  provider: CloudProvider,
  workspaceId: string,
): Promise<void> {
  p.note(
    [
      'A login URL will print below. Open it in your local browser, sign in,',
      'and paste any code Claude asks for back into this terminal.',
    ].join('\n'),
    'Authenticating Claude on workspace',
  );
  const result = await provider.streamCommand(
    workspaceId,
    'bash -lc "claude login || claude /login || true"',
  );
  if (result.code !== 0) {
    p.note(
      'claude login exited non-zero. You can re-run it manually inside the codespace later.',
      'Heads up',
    );
  }
}

/**
 * SSH-checks whether claude is logged in on the workspace by running
 * `claude auth status --json` and inspecting the JSON output for
 * `loggedIn: true`. We deliberately call `auth status` rather than
 * trying to parse the credentials file ourselves — Claude is the
 * source of truth for whether tokens are valid (it knows about
 * expiry, scope mismatches, format changes between versions, etc.).
 *
 * Returns `true` only when Claude reports `loggedIn: true`. Any
 * non-zero exit, malformed JSON, missing field, or `loggedIn: false`
 * counts as not-authed.
 */
export async function verifyClaudeAuth(
  provider: CloudProvider,
  workspaceId: string,
): Promise<boolean> {
  // Run via login shell so the freshly-installed `claude` binary is
  // on PATH (it lives in ~/.local/bin which is added by .bashrc).
  const result = await provider.exec(
    workspaceId,
    'bash -lc "claude auth status 2>/dev/null || true"',
  );
  if (result.code !== 0) return false;
  // Find the first balanced JSON object in stdout — `claude auth
  // status` may print warnings before the JSON on some platforms.
  const jsonStart = result.stdout.indexOf('{');
  if (jsonStart < 0) return false;
  try {
    const parsed = JSON.parse(result.stdout.slice(jsonStart)) as { loggedIn?: boolean };
    return parsed.loggedIn === true;
  } catch {
    return false;
  }
}
