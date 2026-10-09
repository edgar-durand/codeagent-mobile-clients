// src/commands/host/house-proxy-config.ts
//
// Persistence for the house-agent (CodeAgent Cloud) proxy env the supervisor
// writes on a successful house `self_hosted_deploy` and re-reads on every RESUME
// child spawn. Patron: persist → read → child env.
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
// sources `~/.bashrc`. Any per-deploy agent env must therefore be PERSISTED and
// re-injected on every child spawn — this file does that for the house proxy.
//
// Path: `~/.codeam/house-proxy/<deployId>.json` — PER DEPLOY. ⚠️ It used to be
// ONE file, `~/.codeam/house-proxy.json`, "the LAST active house deploy": right
// when a box resumed a single session, wrong once it resumes several
// (codeagent-v07a). Every resumed session got the NEWEST deploy's proxy token —
// which is scoped to a managed provider — so an older Qwen session could run
// and bill on another deploy's provider, a BYO session got house env over its
// own credential, and the announced agent flipped (codeagent-cz34). The global
// file is still written, and read only as the fallback for deploys made before
// the per-deploy files existed.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HOUSE_AGENT_ID, MANAGED_AGENT_ENV, isManagedProviderId } from '@codeam/shared';
import { log } from '../../services/logger';
import { restrictToOwner } from '../../lib/restrict-to-owner';

export function houseProxyConfigPath(): string {
  return path.join(os.homedir(), '.codeam', 'house-proxy.json');
}

/** A deploy id is a uuid-ish path segment — never let one escape the dir. */
const DEPLOY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function deployHouseProxyConfigPath(deployId: string): string | null {
  if (!DEPLOY_ID_RE.test(deployId) || deployId.includes('..')) return null;
  return path.join(os.homedir(), '.codeam', 'house-proxy', `${deployId}.json`);
}

function writeJson0600(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  restrictToOwner(file);
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
  /** MANAGED agent (Managed Agents + Credits): the upstream model to pin as
   *  ANTHROPIC_MODEL (+ the sonnet/opus/haiku aliases). Unset ⇒ the house
   *  MiniMax pin. The backend sends it on the `house_proxy` credential. */
  model?: string;
  /** MANAGED agent: its public id, exported as CODEAM_MANAGED_AGENT_ID so the
   *  CLI announces the right agent (the proxy env alone only says "house"). */
  managedAgentId?: string;
}

/**
 * Persist the house-proxy config atomically (temp write + rename) so a
 * concurrent reader never sees a half-written file. Best-effort: a failure is
 * logged and swallowed — it must NEVER break the deploy.
 */
export function persistHouseProxyConfig(config: HouseProxyConfig, deployId?: string): void {
  try {
    const perDeploy = deployId ? deployHouseProxyConfigPath(deployId) : null;
    if (perDeploy) writeJson0600(perDeploy, config);
    writeJson0600(houseProxyConfigPath(), config);
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
export function clearHouseProxyConfig(deployId?: string): void {
  try {
    fs.rmSync(houseProxyConfigPath(), { force: true });
    // An explicit "this deploy has NO house proxy" marker, so its resume never
    // falls back to another deploy's config.
    const perDeploy = deployId ? deployHouseProxyConfigPath(deployId) : null;
    if (perDeploy) writeJson0600(perDeploy, { none: true });
  } catch {
    /* best-effort */
  }
}

/** Refresh when the persisted token has less than this left (or is expired). */
export const HOUSE_PROXY_REFRESH_WINDOW_SEC = 2 * 24 * 60 * 60;

/**
 * True when `token` is one of OUR agent-proxy JWTs whose `exp` is within
 * `windowSec` of `nowSec` (or already past). Anything that is not a decodable
 * JWT with a numeric `exp` — an OpenRouter key, a corrupt value — is NOT ours to
 * refresh and answers false (codeagent-bt7x).
 */
export function houseProxyTokenExpiring(
  token: string,
  nowSec: number,
  windowSec: number = HOUSE_PROXY_REFRESH_WINDOW_SEC,
): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const payload: unknown = JSON.parse(json);
    if (typeof payload !== 'object' || payload === null) return false;
    const exp = (payload as { exp?: unknown }).exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return false;
    return exp - nowSec < windowSec;
  } catch {
    return false;
  }
}

/** The file `readHouseProxyChildEnv(deployId)` would read, or null. */
function persistedConfigFile(deployId?: string): string | null {
  const perDeploy = deployId ? deployHouseProxyConfigPath(deployId) : null;
  const file = perDeploy && fs.existsSync(perDeploy) ? perDeploy : houseProxyConfigPath();
  return fs.existsSync(file) ? file : null;
}

function readConfigObject(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The persisted house-proxy token for `deployId` when it is OUR proxy token
 * (not an OpenRouter key) and close to expiry — i.e. a resume must refresh it
 * before re-injecting it. Null otherwise. Sync and cheap: the common case
 * (fresh token, BYO deploy) keeps the resume spawn synchronous.
 */
export function houseProxyTokenNeedingRefresh(deployId: string | undefined, nowSec: number): string | null {
  const file = persistedConfigFile(deployId);
  if (!file) return null;
  const o = readConfigObject(file);
  if (!o || o.none === true || o.openRouter === true) return null;
  if (typeof o.token !== 'string' || !o.token) return null;
  return houseProxyTokenExpiring(o.token, nowSec) ? o.token : null;
}

/**
 * Swap the persisted token for `deployId` with `freshToken`, keeping every
 * other field. Writes the same file the resume reads (atomic temp + rename,
 * 0600). Returns false when there is nothing to update or the write failed.
 */
export function rewriteHouseProxyToken(deployId: string | undefined, freshToken: string): boolean {
  try {
    const file = persistedConfigFile(deployId);
    if (!file) return false;
    const o = readConfigObject(file);
    if (!o || typeof o.token !== 'string') return false;
    writeJson0600(file, { ...o, token: freshToken });
    return true;
  } catch (err) {
    log.warn(
      'host-agent',
      `failed to rewrite the refreshed house-proxy token (best-effort): ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Build the child env from the persisted house-proxy config — re-injected on
 * every resume spawn so the house agent authenticates through the proxy after a
 * sleep/wake or supervisor restart. Returns `{}` when there's no valid config
 * (BYO deploy, or the file is absent/corrupt) so a resume degrades to the
 * agent's own credential path.
 */
export function readHouseProxyChildEnv(deployId?: string): Record<string, string> {
  try {
    // THIS deploy's own config when it has one; the global file only for
    // deploys that predate per-deploy configs.
    const perDeploy = deployId ? deployHouseProxyConfigPath(deployId) : null;
    const file = perDeploy && fs.existsSync(perDeploy) ? perDeploy : houseProxyConfigPath();
    const raw = fs.readFileSync(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const o = parsed as Record<string, unknown>;
    if (o.none === true) return {};
    if (typeof o.baseUrl !== 'string' || !o.baseUrl) return {};
    if (typeof o.token !== 'string' || !o.token) return {};
    return buildHouseProxyChildEnv({
      baseUrl: o.baseUrl,
      token: o.token,
      openRouter: o.openRouter === true,
      ...(typeof o.claudeConfigDir === 'string' && o.claudeConfigDir
        ? { claudeConfigDir: o.claudeConfigDir }
        : {}),
      ...(typeof o.model === 'string' && o.model ? { model: o.model } : {}),
      ...(typeof o.managedAgentId === 'string' && o.managedAgentId
        ? { managedAgentId: o.managedAgentId }
        : {}),
    });
  } catch {
    return {};
  }
}

/**
 * MiniMax-M3's context window as we declare it to claude: 1M advertised, 512K
 * guaranteed minimum — we use the guaranteed figure. Both `MAX_CONTEXT_TOKENS`
 * (the window claude ASSUMES for an unknown model) and `AUTO_COMPACT_WINDOW`
 * (the compaction threshold) are set from this ONE constant so they cannot
 * drift apart. See `buildHouseProxyChildEnv`.
 */
export const HOUSE_MODEL_CONTEXT_TOKENS = '512000';

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
    // ⚠️ MAX_CONTEXT_TOKENS, not (only) AUTO_COMPACT_WINDOW — and this is
    // HOUSE-AGENT ONLY: it lives in this builder precisely so a user's own
    // Claude Code (a real Anthropic model claude knows) is never touched.
    //
    // claude does not know `MiniMax-M3`, so it falls back to its
    // unknown-model default (200k). `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is then
    // applied as `Math.min(assumedWindow, env)` — it can only SHRINK the
    // window, never grow it — so the 512000 we used to set here was inert:
    // claude kept believing 200k. Meanwhile a session with a dozen linked
    // integrations carries ~175k tokens of MCP tool schemas on EVERY turn
    // (measured: 475 tools ≈ 698 KB on a real box), so the context started
    // ~88% full and a 28-character prompt triggered a compaction, then the
    // next small tool result triggered another: "Autocompact is thrashing:
    // the context refilled to the limit within 3 turns", 13 compactions in
    // one session (rafaelph90.br@gmail.com, 2026-09-03).
    //
    // claude's own unknown-model notice names the fix: "set
    // CLAUDE_CODE_MAX_CONTEXT_TOKENS to its real window" — that variable is
    // what `wL()` returns for an unrecognised model. MiniMax-M3 is a 1M-context
    // model with a guaranteed minimum of 512K, so 512000 here is the
    // conservative truth, not a wish. AUTO_COMPACT_WINDOW stays as the
    // compaction threshold beneath it.
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: HOUSE_MODEL_CONTEXT_TOKENS,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: HOUSE_MODEL_CONTEXT_TOKENS,
    API_TIMEOUT_MS: '3000000',
  };
  if (cfg.openRouter === true) {
    // OpenRouter routes real Claude model names; ANTHROPIC_API_KEY must be
    // empty so a stale key can't override the Bearer auth token.
    env.ANTHROPIC_API_KEY = '';
  } else if (typeof cfg.model === 'string' && cfg.model) {
    // Explicit model pin — the house's own MiniMax default, or a managed
    // provider's registry model, forwarded verbatim by the caller.
    env.ANTHROPIC_MODEL = cfg.model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = cfg.model;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = cfg.model;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = cfg.model;
  } else if (!isManagedProviderId(cfg.managedAgentId)) {
    // Classic house agent (no managed id, no explicit model) ⇒ MiniMax-M3.
    env.ANTHROPIC_MODEL = 'MiniMax-M3';
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'MiniMax-M3';
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'MiniMax-M3';
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'MiniMax-M3';
  }
  // else: a MANAGED provider with no model string supplied (the self-hosted
  // deploy payload doesn't carry one — only the switch credential fetch
  // does). Omit the pin entirely rather than defaulting to MiniMax-M3: the
  // proxy resolves the real upstream model from the token's providerId claim
  // (resolveManagedModel, apps/api-v2/src/agent-proxy/managed-providers.ts),
  // so Claude Code's own default model string is simply ignored upstream.
  // Pinning MiniMax-M3 here caused the old client to log
  // `[claude-code:unrecognized_model]` on its teardown (codeagent-rew3).
  if (typeof cfg.claudeConfigDir === 'string' && cfg.claudeConfigDir) {
    env.CLAUDE_CONFIG_DIR = cfg.claudeConfigDir;
  }
  if (isManagedProviderId(cfg.managedAgentId)) {
    env[MANAGED_AGENT_ENV] = cfg.managedAgentId;
  }
  return env;
}

/**
 * The WIRE id of the agent a house-rail process is running: the managed id
 * when the bootstrap / switch exported one, else the classic house sentinel.
 * Only meaningful when {@link isHouseProxyEnv} is true.
 */
export function houseRailWireId(env: NodeJS.ProcessEnv): string {
  const managed = env[MANAGED_AGENT_ENV];
  return isManagedProviderId(managed) ? managed : HOUSE_AGENT_ID;
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
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'API_TIMEOUT_MS',
  'CLAUDE_CONFIG_DIR',
  MANAGED_AGENT_ENV,
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

/**
 * The wire id of the managed/house rail this PROCESS runs on, or `null` when the
 * user is on their own agent (BYO). Read live from `env` — an in-session agent
 * switch rewrites it — so a failure classified at turn time reflects the rail
 * that actually served the turn.
 *
 * Callers use it to attribute a provider failure correctly: on our rail the
 * runtime is Claude Code for EVERY managed provider, so the runtime agent id
 * alone would name Anthropic for a DeepInfra/MiniMax outage.
 */
export function currentRailWireId(env: NodeJS.ProcessEnv = process.env): string | null {
  return isHouseProxyEnv(env) ? houseRailWireId(env) : null;
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
