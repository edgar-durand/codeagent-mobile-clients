/**
 * Local Aider credential extraction for `codeam link aider`.
 *
 * Aider has no OAuth login flow — auth is the user's existing
 * model-provider API key supplied via env var or `~/.aider.conf.yml`.
 * The link flow probes (in order):
 *
 *   1. `ANTHROPIC_API_KEY` env var (most common for Claude users).
 *   2. `OPENAI_API_KEY` env var (GPT users).
 *   3. `~/.aider.conf.yml` — if Aider's own config keeps an api-key
 *      field. Many users just rely on env vars; the config file is
 *      treated as an optional secondary source.
 *
 * Returns null when nothing is reachable — the user then runs
 * `codeam link aider --api-key=<key>` to paste explicitly.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LocalAgentToken } from '../strategy';

const AIDER_CONF_FILE = path.join(os.homedir(), '.aider.conf.yml');

const API_KEY_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'DEEPSEEK_API_KEY',
  'GROQ_API_KEY',
] as const;

export async function extractLocalAiderToken(): Promise<LocalAgentToken | null> {
  // 1. Env vars — preferred. Each provider has its own var; first
  //    hit wins because Aider itself picks the first one set when
  //    deciding which model family to default to.
  for (const name of API_KEY_ENV_VARS) {
    const value = process.env[name];
    if (value && value.trim().length > 0) {
      return { method: 'api_key', credential: value.trim(), source: 'flat-file' };
    }
  }

  // 2. ~/.aider.conf.yml — Aider's own config. We grep for an
  //    `api-key:` line rather than parsing YAML, because the file
  //    is rarely structured and the parser dep isn't worth it.
  if (fs.existsSync(AIDER_CONF_FILE)) {
    const conf = fs.readFileSync(AIDER_CONF_FILE, 'utf8');
    const match = conf.match(/^api-key:\s*['"]?([^'"\n]+)['"]?\s*$/m);
    if (match) {
      return { method: 'api_key', credential: match[1].trim(), source: 'flat-file' };
    }
  }

  return null;
}

export function aiderCredentialsPaths(): string[] {
  // Only the config file is watchable by chokidar; env vars don't
  // generate filesystem events. The link command falls back to the
  // 5-min timeout when neither path resolves.
  return [AIDER_CONF_FILE];
}
