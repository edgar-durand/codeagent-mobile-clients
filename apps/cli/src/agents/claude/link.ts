/**
 * `codeam link claude` strategy — credential locator + sign-in
 * launcher for Claude Code. Moved here from
 * `commands/link.ts`'s inline `AGENT_META` block (#56) so adding
 * a new linkable agent is "new file + register" instead of
 * "edit a 50-line switch in the command layer."
 *
 * Behaviour intentionally matches the legacy AGENT_META["claude"]
 * entry byte-for-byte — chokidar watches, the `/login`
 * stdin-piped REPL, and ensureClaudeInstalled.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  extractLocalClaudeToken,
  claudeCredentialsPaths,
} from './local-token';
import { ensureClaudeInstalled } from './installer';
import type {
  AgentCredentialLocator,
  AgentLoginLauncher,
  LocalAgentToken,
  LocalAgentTokenValidation,
} from '../strategy';

/**
 * Validate a captured Claude OAuth credential before we upload it.
 *
 * We refuse ONLY a credential that is GENUINELY unrecoverable — the access
 * token has expired AND there is no refresh token to renew it. An expired
 * access token WITH a refresh token is normal and recoverable (Claude refreshes
 * it on first use), so we DON'T block it (no false positives that would reject
 * a working credential). API keys and unparseable/clockless blobs are
 * `unknown` (let through). This catches the "uploaded a dead credential, but
 * the app cheerfully said connected" class of bug; a fully-live probe (which
 * would also catch a refresh token revoked server-side) is a follow-up.
 */
export function validateClaudeToken(token: LocalAgentToken): LocalAgentTokenValidation {
  if (token.method !== 'oauth') return { status: 'unknown' };
  let oauth: Record<string, unknown>;
  try {
    const parsed = JSON.parse(token.credential) as Record<string, unknown>;
    const inner = parsed.claudeAiOauth;
    oauth = inner && typeof inner === 'object' ? (inner as Record<string, unknown>) : parsed;
  } catch {
    return { status: 'unknown' };
  }
  const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null;
  if (expiresAt === null) return { status: 'unknown' };
  if (expiresAt >= Date.now()) return { status: 'valid' };
  // Expired access token. Recoverable only if a refresh token is present.
  const hasRefresh =
    typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0;
  if (hasRefresh) return { status: 'unknown' };
  return {
    status: 'expired',
    reason: 'Your local Claude session has expired with no refresh token.',
  };
}

export function claudeCredentialLocator(): AgentCredentialLocator {
  return {
    publicId: 'claude_code',
    vendor: 'Anthropic',
    hint: '~/.claude/.credentials.json or the macOS Keychain',
    watchPaths: claudeCredentialsPaths,
    extract: extractLocalClaudeToken,
    validate: validateClaudeToken,
  };
}

/**
 * The long-lived bearer `claude setup-token` prints to stdout
 * (`sk-ant-oat01-…`). Tolerant charset: base64url-ish + dashes.
 */
const SETUP_TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]+/;

/** Pull the setup-token out of the `claude setup-token` stdout, or null. */
export function extractSetupTokenFromOutput(output: string): string | null {
  const m = output.match(SETUP_TOKEN_RE);
  return m ? m[0] : null;
}

/**
 * Capture a dedicated codespace credential via `claude setup-token`
 * instead of cloning the user's interactive `~/.claude/.credentials.json`.
 *
 * Why: the setup-token is a long-lived (1-year) bearer that does NOT rotate,
 * so the codespace using it can't trip Anthropic's refresh-token reuse-
 * detection and revoke the user's laptop session (the root-cause bug). The
 * user completes the browser authorization + pastes the code into the
 * spawned flow; we tee stdout (so they see the prompts + token) while
 * capturing the `sk-ant-oat01-…` token to upload with method `setup_token`.
 */
export function captureClaudeSetupToken(): Promise<LocalAgentToken> {
  return new Promise<LocalAgentToken>((resolve, reject) => {
    // stdin inherited → user pastes the auth code; stderr inherited →
    // prompts/URL visible; stdout piped → we capture the printed token
    // (and tee it back so the user still sees everything).
    const child = spawn('claude', ['setup-token'], {
      stdio: ['inherit', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      out += s;
      process.stdout.write(s);
    });
    child.on('error', (err) => reject(err));
    child.on('exit', (code) => {
      const token = extractSetupTokenFromOutput(out);
      if (token) {
        resolve({ method: 'setup_token', credential: token, source: 'setup-token' });
        return;
      }
      reject(
        new Error(
          `\`claude setup-token\` exited (code=${code ?? 'null'}) without producing a token. ` +
            'Complete the browser authorization and paste the code when prompted, then re-run.',
        ),
      );
    });
  });
}

export function claudeLoginLauncher(): AgentLoginLauncher {
  return {
    ensureInstalled: ensureClaudeInstalled,
    launch(): ChildProcess {
      // Open the Claude REPL and pipe `/login` to its stdin so the
      // sign-in menu appears without the user having to type the
      // slash command themselves. `stdio: ['pipe', 'inherit',
      // 'inherit']` lets the user see Claude's UI + complete the
      // OAuth in their browser; the link command captures the
      // token via the file watcher running in parallel.
      const child = spawn('claude', [], { stdio: ['pipe', 'inherit', 'inherit'] });
      child.stdin?.write('/login\n');
      // Intentionally NOT closing stdin — the REPL stays interactive
      // so the user can finish any vendor prompts (paste-back code,
      // menu navigation) without their input being dropped.
      return child;
    },
    // Preferred path for Claude: a dedicated non-rotating setup-token,
    // so the codespace credential never shares a refresh chain with the
    // user's laptop session.
    captureSetupToken: captureClaudeSetupToken,
  };
}
