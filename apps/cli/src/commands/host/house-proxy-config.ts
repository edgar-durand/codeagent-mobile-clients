// src/commands/host/house-proxy-config.ts
//
// Persistence for the house-agent (CodeAgent Cloud) proxy env the supervisor
// writes on a successful house `self_hosted_deploy` and re-reads on every RESUME
// child spawn. Mirrors `headroom-config.ts` (persist → read → child env).
//
// ⚠️ WHY THIS EXISTS (Rafael, 2026-08-05): the house-proxy env
// (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN + model pins + CLAUDE_CONFIG_DIR)
// was ONLY set in the child env when the host-agent PROCESSED the deploy command
// (`houseProxy` branch in host-agent.ts). On a warm-codespace sleep/wake the
// supervisor restarts and resumes the session via `defaultResumeSpawner` (bare
// `codeam`) WITHOUT re-processing the deploy — so the woken Claude agent had NO
// proxy env → Claude Code fell back to direct api.anthropic.com with no
// credential → every prompt failed LOCALLY with "Authentication required"
// (~77 ms). The deploy-time `~/.bashrc` exports don't help: the woken host-agent
// is relaunched by the container entrypoint in a NON-login shell that never
// sources `~/.bashrc`. This is the exact gap `readHeadroomChildEnv` already
// closes for HEADROOM_* — this file does the same for the house proxy.
//
// Path: `~/.codeam/house-proxy.json` — the LAST active house deploy, matching
// the resume spawner's `CODEAM_RESUME_LATEST` ("resume the most-recent session").
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { log } from '../../services/logger';
import { restrictToOwner } from '../../lib/restrict-to-owner';

export function houseProxyConfigPath(): string {
  return path.join(os.homedir(), '.codeam', 'house-proxy.json');
}

/** On-disk house-proxy config shape (mirrors {@link readHouseProxyChildEnv}). */
export interface HouseProxyConfig {
  /** ANTHROPIC_BASE_URL — the house proxy (`…/api/v1/agent-proxy`) or the user's
   *  OpenRouter gateway. */
  baseUrl: string;
  /** ANTHROPIC_AUTH_TOKEN — the minted house proxy token (or the OpenRouter key). */
  token: string;
  /** true → OpenRouter gateway (real Claude model names, ANTHROPIC_API_KEY="");
   *  false/undefined → CodeAgent Cloud house proxy (MiniMax model pins). */
  openRouter?: boolean;
  /** Per-deploy isolated Claude config dir (CLAUDE_CONFIG_DIR) so the woken
   *  session boots clean in gateway mode, not the box's personal Claude login. */
  claudeConfigDir?: string;
}

/**
 * Persist the house-proxy config atomically (temp write + rename) so a
 * concurrent reader never sees a half-written file. Best-effort: a failure is
 * logged and swallowed — it must NEVER break the deploy.
 */
export function persistHouseProxyConfig(config: HouseProxyConfig): void {
  try {
    const file = houseProxyConfigPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    restrictToOwner(file);
  } catch (err) {
    log.warn(
      'host-agent',
      `failed to persist house-proxy config (best-effort): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Remove the persisted config. Called when a NON-house (BYO-credential) deploy
 * takes over the box so a resume can't wrongly re-inject a stale house proxy on
 * top of the user's own agent credential.
 */
export function clearHouseProxyConfig(): void {
  try {
    fs.rmSync(houseProxyConfigPath(), { force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Build the child env from the persisted house-proxy config — re-injected on
 * every resume spawn so the house agent authenticates through the proxy after a
 * sleep/wake or supervisor restart. Returns `{}` when there's no valid config
 * (BYO deploy, or the file is absent/corrupt) so a resume degrades to the
 * agent's own credential path.
 */
export function readHouseProxyChildEnv(): Record<string, string> {
  try {
    const raw = fs.readFileSync(houseProxyConfigPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const o = parsed as Record<string, unknown>;
    if (typeof o.baseUrl !== 'string' || !o.baseUrl) return {};
    if (typeof o.token !== 'string' || !o.token) return {};
    return buildHouseProxyChildEnv({
      baseUrl: o.baseUrl,
      token: o.token,
      openRouter: o.openRouter === true,
      ...(typeof o.claudeConfigDir === 'string' && o.claudeConfigDir
        ? { claudeConfigDir: o.claudeConfigDir }
        : {}),
    });
  } catch {
    return {};
  }
}

/**
 * The house/gateway agent env — the ONE builder shared by the deploy path
 * (host-agent childEnv), the resume path ({@link readHouseProxyChildEnv}),
 * and the in-session `switch_agent` house target (adapter spawn extraEnv).
 * Mirrors the codespace house bootstrap byte-for-byte
 * (apps/api-v2/src/codespaces/agent.ts).
 */
export function buildHouseProxyChildEnv(cfg: HouseProxyConfig): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: cfg.baseUrl,
    ANTHROPIC_AUTH_TOKEN: cfg.token,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '512000',
    API_TIMEOUT_MS: '3000000',
  };
  if (cfg.openRouter === true) {
    // OpenRouter routes real Claude model names; ANTHROPIC_API_KEY must be
    // empty so a stale key can't override the Bearer auth token.
    env.ANTHROPIC_API_KEY = '';
  } else {
    env.ANTHROPIC_MODEL = 'MiniMax-M3';
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'MiniMax-M3';
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'MiniMax-M3';
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'MiniMax-M3';
  }
  if (typeof cfg.claudeConfigDir === 'string' && cfg.claudeConfigDir) {
    env.CLAUDE_CONFIG_DIR = cfg.claudeConfigDir;
  }
  return env;
}

/**
 * Every env key the house/gateway proxy setup may have exported into this
 * process or a prior adapter spawn. A switch AWAY from the house agent maps
 * each of these to `undefined` in the adapter's extraEnv — Node's `spawn`
 * omits `undefined`-valued env entries, so the next agent boots CLEAN of the
 * proxy routing (a real Claude Code switch on a house box would otherwise
 * inherit `ANTHROPIC_BASE_URL` and keep talking to the managed proxy).
 */
export const HOUSE_PROXY_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'API_TIMEOUT_MS',
  'CLAUDE_CONFIG_DIR',
] as const;

/** extraEnv overrides that DELETE the house-proxy env from the child spawn. */
export function clearHouseProxyEnvOverrides(): Record<string, undefined> {
  const out: Record<string, undefined> = {};
  for (const key of HOUSE_PROXY_ENV_KEYS) out[key] = undefined;
  return out;
}

/**
 * True when this PROCESS was launched with the managed house-proxy env (a
 * house deploy exports it into the pair-auto child). A user's own custom
 * `ANTHROPIC_BASE_URL` never matches — only our agent-proxy path does.
 */
export function isHouseProxyEnv(env: NodeJS.ProcessEnv): boolean {
  return (
    typeof env.ANTHROPIC_AUTH_TOKEN === 'string' &&
    env.ANTHROPIC_AUTH_TOKEN.length > 0 &&
    (env.ANTHROPIC_BASE_URL ?? '').includes('/api/v1/agent-proxy')
  );
}

/** Subset of `env` holding the house-proxy keys (seed for a later re-spawn). */
export function pickHouseProxyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of HOUSE_PROXY_ENV_KEYS) {
    const v = env[key];
    if (typeof v === 'string') out[key] = v;
  }
  return out;
}
