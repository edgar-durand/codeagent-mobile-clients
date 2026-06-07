/**
 * Local Gemini credential extraction for `codeam link gemini`.
 *
 * Gemini CLI (`@google/gemini-cli`) stores OAuth credentials in two
 * places depending on platform:
 *
 *   - **macOS keychain** — primary on Darwin (service
 *     `gemini-cli-oauth`, account `main-account`). Older releases
 *     wrote to the JSON file below; the current keychain-first
 *     storage falls back to the file on read and migrates it on
 *     first run.
 *   - **`~/.gemini/oauth_creds.json`** — the legacy + Linux file
 *     location. Shape matches Google's `Credentials` type:
 *
 *         { access_token, refresh_token, token_type,
 *           scope, expiry_date /* ms since epoch *\/ }
 *
 * The link flow reads the file. macOS users who already migrated to
 * keychain-only storage have no file to capture — they're routed to
 * `gemini auth login --print` (see `link.ts`) which re-emits the
 * credentials JSON on stdout. API-key users go through the existing
 * `--api-key=<key>` escape hatch on commands/link.ts.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LocalAgentToken } from '../strategy';

export function geminiCredentialsPath(): string {
  return path.join(os.homedir(), '.gemini', 'oauth_creds.json');
}

export function geminiCredentialsPaths(): string[] {
  return [geminiCredentialsPath()];
}

export function geminiCredentialsMtime(): number | null {
  try {
    return fs.statSync(geminiCredentialsPath()).mtimeMs;
  } catch {
    return null;
  }
}

export async function extractLocalGeminiToken(): Promise<LocalAgentToken | null> {
  const file = geminiCredentialsPath();
  if (!fs.existsSync(file)) return null;
  const credential = fs.readFileSync(file, 'utf8').trim();
  if (credential.length === 0) return null;
  return { method: 'oauth', credential, source: 'flat-file' };
}

export async function hasLocalGeminiAuth(): Promise<boolean> {
  return (await extractLocalGeminiToken()) !== null;
}

/**
 * Lightweight CLI-side mirror of the server's
 * `GeminiProvisioningStrategy.validateCredential` — refuses uploading
 * an already-expired snapshot so the vault doesn't accumulate dead
 * tokens. Google's `Credentials` type stores expiry as `expiry_date`
 * in MILLISECONDS since epoch.
 *
 * Returns:
 *   - `expired` when `expiry_date` is in the past
 *   - `unknown` when the field is absent / non-numeric (older
 *     snapshots, raw API keys) — let the upload proceed and defer
 *     to the server's runtime check
 *   - `valid` when the expiry is in the future
 */
export type GeminiTokenStatus = 'valid' | 'expired' | 'unknown';

export function validateLocalGeminiToken(credential: string): {
  status: GeminiTokenStatus;
  reason?: string;
  expiresAt?: number;
} {
  let parsed: { expiry_date?: number; refresh_token?: string };
  try {
    parsed = JSON.parse(credential) as typeof parsed;
  } catch {
    return { status: 'unknown' };
  }
  // Match the server's policy: the `access_token` (and its
  // `expiry_date`) lives ~1 hour, but `refresh_token` is long-lived
  // and is what Gemini CLI's `oauth2Client` uses to mint fresh
  // access tokens on every call. As long as we have a refresh_token
  // the snapshot is usable indefinitely. Gating "expired" on
  // `expiry_date` only would refuse to upload a still-good token
  // every hour and force the user to re-auth Gemini constantly.
  if (typeof parsed.refresh_token === 'string' && parsed.refresh_token.length > 0) {
    return {
      status: 'valid',
      expiresAt: typeof parsed.expiry_date === 'number' ? parsed.expiry_date : undefined,
    };
  }
  if (typeof parsed.expiry_date !== 'number') return { status: 'unknown' };
  const expiresAt = parsed.expiry_date;
  if (Date.now() >= expiresAt) {
    return {
      status: 'expired',
      reason: 'Gemini OAuth access token expired (no refresh_token in snapshot)',
      expiresAt,
    };
  }
  return { status: 'valid', expiresAt };
}
