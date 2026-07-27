/**
 * Local opencode credential extraction for `codeam link opencode`.
 *
 * opencode is model-agnostic and AUTO-DETECTS provider API keys from env vars
 * (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) — same model as aider. The link flow
 * probes those env vars; returns null when none is set, and the user then runs
 * `codeam link opencode --api-key=<key>` to paste explicitly (or links from the
 * mobile app, which vaults a pasted provider key directly).
 */

import type { LocalAgentToken } from '../strategy';

const API_KEY_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
] as const;

export async function extractLocalOpencodeToken(): Promise<LocalAgentToken | null> {
  for (const name of API_KEY_ENV_VARS) {
    const value = process.env[name];
    if (value && value.trim().length > 0) {
      return { method: 'api_key', credential: value.trim(), source: 'flat-file' };
    }
  }
  return null;
}

/** No single credential FILE — opencode reads provider keys from env. */
export function opencodeCredentialsPaths(): string[] {
  return [];
}
