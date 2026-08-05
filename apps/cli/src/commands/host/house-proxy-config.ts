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
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: o.baseUrl,
      ANTHROPIC_AUTH_TOKEN: o.token,
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '512000',
      API_TIMEOUT_MS: '3000000',
    };
    if (o.openRouter === true) {
      // OpenRouter routes real Claude model names; ANTHROPIC_API_KEY must be
      // empty so a stale key can't override the Bearer auth token.
      env.ANTHROPIC_API_KEY = '';
    } else {
      env.ANTHROPIC_MODEL = 'MiniMax-M3';
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'MiniMax-M3';
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'MiniMax-M3';
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'MiniMax-M3';
    }
    if (typeof o.claudeConfigDir === 'string' && o.claudeConfigDir) {
      env.CLAUDE_CONFIG_DIR = o.claudeConfigDir;
    }
    return env;
  } catch {
    return {};
  }
}
