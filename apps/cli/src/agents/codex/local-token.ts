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
import type { LocalAgentToken } from '../strategy';

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

export function codexCredentialsPaths(): string[] {
  return [codexCredentialsPath()];
}

export function codexCredentialsMtime(): number | null {
  const file = codexCredentialsPath();
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Convenience yes/no around `extractLocalCodexToken`. Used by
 * `codeam link codex` to short-circuit straight to upload when the
 * user already has a token from a prior `codex login`.
 */
export async function hasLocalCodexAuth(): Promise<boolean> {
  return (await extractLocalCodexToken()) !== null;
}

/**
 * Lightweight CLI-side mirror of the server's
 * `CodexProvisioningStrategy.validateCredential` — used by
 * `codeam link codex` to refuse uploading an already-expired
 * `~/.codex/auth.json` snapshot. Without this guard the link flow
 * happily stores a stale snapshot in the vault; every subsequent
 * deploy bootstraps a codespace whose Codex CLI immediately returns
 * `token_expired` 401s because the access_token is in the past AND
 * the refresh_token may have been used by another caller already
 * (Codex rotates refresh tokens — once spent, gone).
 *
 * Probes the same three locations as the server in the same order:
 *   1. top-level `expires_at`           (legacy Codex auth.json)
 *   2. `tokens.expires_at`              (intermediate releases)
 *   3. `tokens.id_token` JWT `exp` claim (current Codex, mid-2026+)
 *
 * Returns:
 *   - `expired` when at least one source resolves to a past timestamp
 *   - `unknown` when nothing identifying is present (raw API key, or
 *     a never-seen auth.json shape) — we let the upload proceed and
 *     defer to the server's check rather than block on a guess
 *   - `valid` when the resolved expiry is in the future
 */
export type CodexTokenStatus = 'valid' | 'expired' | 'unknown';

export function validateLocalCodexToken(credential: string): {
  status: CodexTokenStatus;
  reason?: string;
  expiresAt?: number;
} {
  let parsed: {
    expires_at?: number;
    tokens?: { expires_at?: number; id_token?: string };
  };
  try {
    parsed = JSON.parse(credential) as typeof parsed;
  } catch {
    // Raw OPENAI_API_KEY — non-JSON, no expiry signal.
    return { status: 'unknown' };
  }
  const directExp =
    typeof parsed.expires_at === 'number'
      ? parsed.expires_at
      : typeof parsed.tokens?.expires_at === 'number'
        ? parsed.tokens.expires_at
        : undefined;
  const jwtExp = decodeJwtExp(parsed.tokens?.id_token);
  const exp = directExp ?? jwtExp;
  if (exp === undefined) return { status: 'unknown' };
  const expiresAt = exp < 1e12 ? exp * 1000 : exp;
  if (Date.now() >= expiresAt) {
    return {
      status: 'expired',
      reason: 'Codex OAuth access token expired',
      expiresAt,
    };
  }
  return { status: 'valid', expiresAt };
}

/**
 * Extract the `exp` claim from a JWT without verifying the signature.
 * Codex's `tokens.id_token` is an OpenAI OAuth JWT — we only want the
 * declared expiry, not trust it as an authn proof, so the second
 * base64url-encoded segment is enough. Defensive against malformed
 * JWTs (wrong segment count, non-JSON payload, missing claim) so a
 * corrupt auth.json doesn't break the whole link flow.
 */
function decodeJwtExp(jwt: string | undefined): number | undefined {
  if (!jwt) return undefined;
  const parts = jwt.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '==='.slice((base64.length + 3) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as {
      exp?: number;
    };
    return typeof payload.exp === 'number' ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}
