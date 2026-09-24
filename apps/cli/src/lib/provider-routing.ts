import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HOUSE_PROXY_ENV_KEYS, isHouseProxyEnv } from '../commands/host/house-proxy-config';

/**
 * Provider-routing attribution for the spawned agent (codeagent-tvqt).
 *
 * WHY: a user saw `API Error: 402 Insufficient credits` from her agent. Our
 * house proxy was proven NOT to be the source (our gate's wording differs and
 * we served no 402s), but the CLI debug log carried nothing that said WHICH
 * endpoint the agent was actually talking to — so the attribution took a
 * manual investigation instead of one grep. This module answers that in one
 * line, redacted to scheme+host (never a key, never a path or query string):
 *
 *   provider routing agent=claude anthropic=https://api.anthropic.com
 *     openai=default gemini=default opencode=[openrouter=https://openrouter.ai]
 *     houseProxy=no houseKeys=[] codeamKeys=[]
 *
 * and classifies a provider billing line (`API Error: 402`, `insufficient
 * credits`, `insufficient balance`) as EXTERNAL (the user's own provider) vs
 * HOUSE (our proxy) so the debug log carries a structured
 * `provider_billing_external` marker the next time this happens.
 *
 * Pure + best-effort: never throws, never reads a secret into its output.
 */

/** Env vars the supported agents read their API base URL from. */
export const PROVIDER_BASE_URL_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'GEMINI_API_BASE',
  'GOOGLE_GEMINI_BASE_URL',
] as const;

export type ProviderBaseUrlEnvKey = (typeof PROVIDER_BASE_URL_ENV_KEYS)[number];

/** Value logged when a provider env var is unset — the agent uses its built-in default. */
export const ROUTING_DEFAULT = 'default';

export interface ProviderRouting {
  /** Each base-URL env var → redacted `scheme://host[:port]`, or `default` when unset. */
  env: Record<ProviderBaseUrlEnvKey, string>;
  /** opencode's configured providers (`provider.<id>.options.baseURL`), redacted. */
  opencode: Array<{ provider: string; origin: string }>;
  /** True when this env routes through OUR managed house proxy. */
  houseProxy: boolean;
  /** Names (never values) of the house-proxy env keys present. */
  houseKeys: string[];
  /** Names (never values) of the CODEAM_* env keys present. */
  codeamKeys: string[];
}

/**
 * Reduce a URL to `scheme://host[:port]`. Drops userinfo, path, query and
 * fragment — a base URL can carry a key in any of those. Returns `null` for an
 * empty value and the literal `invalid-url` for something `URL` can't parse,
 * so the log still says "it was set, and it was garbage".
 */
export function redactUrlToOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (!u.host) return 'invalid-url';
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'invalid-url';
  }
}

/**
 * Read opencode's provider base URLs from its config files, most specific
 * first (project `opencode.json[c]`, then `~/.config/opencode/opencode.json[c]`).
 * jsonc is tolerated by stripping `//` line comments; a file that still won't
 * parse is skipped. Best-effort — a missing/garbled config yields `[]`.
 */
export function readOpencodeProviderOrigins(opts: {
  cwd?: string;
  homeDir?: string;
  readFile?: (file: string) => string;
} = {}): Array<{ provider: string; origin: string }> {
  const home = opts.homeDir ?? os.homedir();
  const readFile = opts.readFile ?? ((f: string) => fs.readFileSync(f, 'utf8'));
  const candidates: string[] = [];
  if (opts.cwd) {
    candidates.push(path.join(opts.cwd, 'opencode.json'), path.join(opts.cwd, 'opencode.jsonc'));
  }
  candidates.push(
    path.join(home, '.config', 'opencode', 'opencode.json'),
    path.join(home, '.config', 'opencode', 'opencode.jsonc'),
  );
  const out: Array<{ provider: string; origin: string }> = [];
  const seen = new Set<string>();
  for (const file of candidates) {
    let text: string;
    try {
      text = readFile(file);
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
    } catch {
      continue;
    }
    const providers = (parsed as { provider?: unknown } | null)?.provider;
    if (!providers || typeof providers !== 'object') continue;
    for (const [id, cfg] of Object.entries(providers as Record<string, unknown>)) {
      if (seen.has(id)) continue; // project config wins over the global one
      const options = (cfg as { options?: Record<string, unknown> } | null)?.options;
      const base = options?.baseURL ?? options?.baseUrl ?? options?.base_url;
      const origin = redactUrlToOrigin(base);
      if (!origin) continue;
      seen.add(id);
      out.push({ provider: id, origin });
    }
  }
  return out;
}

/** Describe the provider routing in effect for `env` (the agent's spawn env). */
export function describeProviderRouting(
  env: NodeJS.ProcessEnv,
  opts: { cwd?: string; homeDir?: string; readFile?: (file: string) => string } = {},
): ProviderRouting {
  const routed = {} as Record<ProviderBaseUrlEnvKey, string>;
  for (const key of PROVIDER_BASE_URL_ENV_KEYS) {
    routed[key] = redactUrlToOrigin(env[key]) ?? ROUTING_DEFAULT;
  }
  let opencode: Array<{ provider: string; origin: string }> = [];
  try {
    opencode = readOpencodeProviderOrigins(opts);
  } catch {
    /* best-effort */
  }
  const houseKeys = HOUSE_PROXY_ENV_KEYS.filter(
    (k) => typeof env[k] === 'string' && (env[k] as string).length > 0,
  );
  const codeamKeys = Object.keys(env)
    .filter((k) => k.startsWith('CODEAM_') && typeof env[k] === 'string' && (env[k] as string).length > 0)
    .sort();
  return { env: routed, opencode, houseProxy: isHouseProxyEnv(env), houseKeys, codeamKeys };
}

/** One-line, grep-friendly rendering for the debug log. Carries names and hosts only. */
export function formatProviderRouting(r: ProviderRouting, label?: string): string {
  const parts = [
    label ? `agent=${label}` : null,
    `anthropic=${r.env.ANTHROPIC_BASE_URL}`,
    `openai=${r.env.OPENAI_BASE_URL !== ROUTING_DEFAULT ? r.env.OPENAI_BASE_URL : r.env.OPENAI_API_BASE}`,
    `gemini=${r.env.GEMINI_API_BASE !== ROUTING_DEFAULT ? r.env.GEMINI_API_BASE : r.env.GOOGLE_GEMINI_BASE_URL}`,
    `opencode=[${r.opencode.map((p) => `${p.provider}=${p.origin}`).join(',')}]`,
    `houseProxy=${r.houseProxy ? 'yes' : 'no'}`,
    `houseKeys=[${r.houseKeys.join(',')}]`,
    `codeamKeys=[${r.codeamKeys.join(',')}]`,
  ];
  return parts.filter((p): p is string => p !== null).join(' ');
}

/**
 * A provider-side billing rejection as agents surface it. Deliberately
 * narrow: a bare `402` in a stack trace or a diff must not match, so the
 * status needs a billing word nearby, and the wordings are the ones seen
 * live (`API Error: 402 Insufficient credits`, `402 insufficient balance
 * (1008)`, `Payment Required`).
 */
export const PROVIDER_BILLING_RE =
  /(?:api error|http|status)[:\s]+402\b|\b402\b[^\n]{0,40}(?:payment required|insufficient|credits?|balance)|insufficient (?:credits?|balance|funds)|payment required/i;

export function matchesProviderBilling(text: string): boolean {
  return PROVIDER_BILLING_RE.test(text);
}

export interface ProviderBillingMarker {
  marker: 'provider_billing_external' | 'provider_billing_house';
  /** Where the agent's Anthropic traffic goes (redacted), or `default`. */
  anthropicHost: string;
  /** The matched line, key-scrubbed and capped, for the log only. */
  snippet: string;
}

/** Scrub anything key-shaped from a snippet destined for the log. */
export function scrubSecrets(text: string): string {
  return text
    .replace(/\b(?:sk|pk|rk|key|token)[-_][A-Za-z0-9_-]{12,}/gi, '[redacted]')
    .replace(/bearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer [redacted]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]');
}

/**
 * Classify a billing line against the routing in effect. `null` when the text
 * carries no billing signal. `provider_billing_house` when this process runs
 * on our managed proxy (a 402 there is OURS to investigate); otherwise
 * `provider_billing_external` — the user's own provider account.
 */
export function classifyProviderBilling(
  text: string,
  env: NodeJS.ProcessEnv,
): ProviderBillingMarker | null {
  if (!matchesProviderBilling(text)) return null;
  const line = text.split('\n').find((l) => PROVIDER_BILLING_RE.test(l)) ?? text;
  return {
    marker: isHouseProxyEnv(env) ? 'provider_billing_house' : 'provider_billing_external',
    anthropicHost: redactUrlToOrigin(env.ANTHROPIC_BASE_URL) ?? ROUTING_DEFAULT,
    snippet: scrubSecrets(line.trim()).slice(0, 160),
  };
}
