/**
 * Self-hosted host-agent — per-agent credential provisioning on the
 * user's own box.
 *
 * Design of record:
 * docs/superpowers/specs/2026-06-17-self-hosted-execution-plane-design.md
 *
 * When the backend dispatches a `self_hosted_deploy`, the host-agent
 * must write the user's LinkedAgent credential to the same on-disk
 * locations the codespace bootstrap writes them to, BEFORE spawning the
 * `codeam pair-auto` child — so the child's agent boots already
 * authenticated. This module is the CLI-side mirror of the backend's
 * `codespaces/agent.ts` `getAuthSnippet` / `getPostAuthSnippet`:
 *
 *   - Claude  → `~/.claude/.credentials.json` (oauth_token JSON) or the
 *               `ANTHROPIC_API_KEY` env var (api_key); plus a minimal
 *               `~/.claude.json` onboarding-skip file.
 *   - Codex   → `~/.codex/auth.json` (oauth_token JSON) or the
 *               `OPENAI_API_KEY` env var (api_key).
 *
 * We write the files directly (Node fs) instead of shelling out a bash
 * snippet — same destination + mode (0600), no `printf`/`bash`
 * round-trip, and it stays unit-testable with a redirected HOME.
 *
 * Credential plaintext is NEVER persisted by the host-agent beyond
 * these agent-owned files; we do not log it.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentAuth, AgentId } from '@codeam/shared';
import { restrictToOwner } from '../../lib/restrict-to-owner';

/**
 * Map the public LinkedAgent id the deploy command carries
 * (`claude_code`, `codex`, …) to the internal agent id used for
 * provisioning + the `codeam` agent registry. The backend mints the
 * pair-auto token with the internal id, so the CHILD resolves its agent
 * from the claim response — this map is only for picking which
 * credential files to write.
 *
 * Kept as a small explicit table (not a heuristic) so an unknown public
 * id fails loud rather than silently writing the wrong agent's files.
 */
const PUBLIC_TO_INTERNAL_AGENT: Readonly<Record<string, AgentId>> = {
  claude_code: 'claude',
  claude: 'claude',
  codex: 'codex',
  copilot: 'copilot',
  cursor: 'cursor',
  aider: 'aider',
  coderabbit: 'coderabbit',
  gemini: 'gemini',
  kimi: 'kimi',
  opencode: 'opencode',
};

/** Resolve a public LinkedAgent id to the internal agent id, or null. */
export function toInternalAgentId(publicAgentId: string): AgentId | null {
  return PUBLIC_TO_INTERNAL_AGENT[publicAgentId] ?? null;
}

/** A credential provisioner: writes one agent's auth to disk + returns env. */
interface AgentProvisioner {
  /**
   * Write the credential files this agent reads at startup. Returns env
   * vars to export into the child for the `api_key` path (Claude/Codex
   * read the key from the environment, not a file). Empty for the
   * `oauth_token` path (everything is a file).
   */
  write(auth: AgentAuth, home: string): Record<string, string>;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeFile0600(filePath: string, contents: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, contents, { encoding: 'utf8', mode: 0o600 });
  // mkdir/writeFile honour the umask, so re-assert the mode explicitly —
  // the credential file must be 0600 regardless of the process umask.
  // On Windows, restrictToOwner applies icacls ACLs instead of chmod.
  restrictToOwner(filePath);
}

/** Remove a stale credential file if present (best-effort, never throws). */
function rmIfExists(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // best-effort cleanup — a leftover stale file is the exact bug we guard,
    // but failing to delete it must never abort provisioning.
  }
}

const claudeProvisioner: AgentProvisioner = {
  write(auth, home): Record<string, string> {
    const credentialsJson = path.join(home, '.claude', '.credentials.json');
    if (auth.kind === 'api_key') {
      // Claude reads the raw key from ANTHROPIC_API_KEY. No file. Remove any
      // stale OAuth credentials file so it can't shadow the new api_key on a
      // re-provision that changed the authType.
      rmIfExists(credentialsJson);
      return { ANTHROPIC_API_KEY: auth.value };
    }
    // oauth_token comes in two shapes depending on the link flow:
    //
    //   1. Bare setup-token  (e.g. `sk-ant-oat01-…`): produced by
    //      `codeam link claude`. This is NOT JSON — writing it verbatim
    //      to `.credentials.json` creates a malformed file that makes
    //      Claude return 401. The live-verified fix is to pass it as the
    //      CLAUDE_CODE_OAUTH_TOKEN env var instead, which Claude reads
    //      before checking the file (env var takes precedence).
    //
    //   2. JSON blob  (value starts with `{`): the full contents of
    //      `~/.claude/.credentials.json` captured by the interactive-
    //      login flow. Keep the existing behaviour — write verbatim.
    const value = auth.value.trim();
    const isJsonBlob = value.startsWith('{');

    if (isJsonBlob) {
      // Interactive-login JSON blob → write to disk, nothing in env.
      writeFile0600(credentialsJson, value);
    } else {
      // Bare setup-token → do NOT write .credentials.json (would be malformed
      // JSON → 401); it goes in CLAUDE_CODE_OAUTH_TOKEN below. Remove any stale
      // OAuth file so it can't shadow the env-var token on a re-provision.
      rmIfExists(credentialsJson);
    }

    // Minimal onboarding-skip state file so the agent doesn't drop into
    // first-run UX. The richer (real ~/.claude.json) variant is only
    // available when the link flow captured it; the deploy command does
    // not carry it, so we synthesise the minimal file — same fallback
    // the backend's getPostAuthSnippet uses when stateVar is empty.
    const claudeJson = path.join(home, '.claude.json');
    if (!fs.existsSync(claudeJson)) {
      writeFile0600(
        claudeJson,
        JSON.stringify({ hasCompletedOnboarding: true, customApiKeyResponses: { approved: [] } }),
      );
    }

    return isJsonBlob ? {} : { CLAUDE_CODE_OAUTH_TOKEN: value };
  },
};

const codexProvisioner: AgentProvisioner = {
  write(auth, home): Record<string, string> {
    const authJson = path.join(home, '.codex', 'auth.json');
    if (auth.kind === 'api_key') {
      // Codex prefers ~/.codex/auth.json over OPENAI_API_KEY when both exist,
      // so a stale auth.json from a prior ChatGPT-subscription deploy would
      // shadow the new api_key. Remove it before handing back the env var.
      rmIfExists(authJson);
      return { OPENAI_API_KEY: auth.value };
    }
    // oauth_token → ~/.codex/auth.json verbatim (the ChatGPT subscription blob).
    writeFile0600(authJson, auth.value);
    return {};
  },
};

const geminiProvisioner: AgentProvisioner = {
  write(auth, home): Record<string, string> {
    const settingsJson = path.join(home, '.gemini', 'settings.json');
    const oauthCreds = path.join(home, '.gemini', 'oauth_creds.json');
    if (auth.kind === 'api_key') {
      // Gemini reads GEMINI_API_KEY from the env. Pin settings.json to the
      // api-key auth type and remove any stale OAuth creds so they can't
      // shadow the key on a re-provision that changed the authType.
      rmIfExists(oauthCreds);
      writeFile0600(settingsJson, '{"security":{"auth":{"selectedType":"gemini-api-key"}}}');
      return { GEMINI_API_KEY: auth.value };
    }
    // oauth_token → the contents of ~/.gemini/oauth_creds.json verbatim (the
    // google-auth-library Credentials blob captured by the in-app OAuth flow /
    // `codeam link gemini`). Pin settings.json to the personal-OAuth auth type
    // so the CLI loads the creds file instead of prompting to log in.
    writeFile0600(oauthCreds, auth.value);
    writeFile0600(settingsJson, '{"security":{"auth":{"selectedType":"oauth-personal"}}}');
    return {};
  },
};

const cursorProvisioner: AgentProvisioner = {
  write(auth, home): Record<string, string> {
    // Cursor login state. cursor-agent (CLI + `cursor-agent acp`) authenticates
    // by reading ~/.config/cursor/auth.json — verified live via `strace`:
    // it opens that path; writing the {accessToken,refreshToken,userId} blob
    // there flips `cursor-agent status` to "Logged in" and makes the ACP
    // `session/new` succeed. (Path confirmed; `~/.cursor/auth.json` is NOT read.)
    const authJson = path.join(home, '.config', 'cursor', 'auth.json');

    if (auth.kind === 'api_key') {
      // A real dashboard "User API Key" → cursor-agent reads CURSOR_API_KEY from
      // the env. Remove any stale login-state file so it can't shadow the key.
      rmIfExists(authJson);
      return { CURSOR_API_KEY: auth.value };
    }

    // oauth_token → the vaulted Cursor OAuth blob
    // (`{"accessToken":"...","refreshToken":"...","userId":"..."}`), written
    // VERBATIM to the login-state file. The accessToken must NOT go in
    // CURSOR_API_KEY: that env var expects a dashboard-generated API key and the
    // OAuth device-flow token is rejected there ("invalid API key", verified) —
    // the ACP `cursor_login` auth method reads the login state instead. The
    // refreshToken in the blob lets cursor-agent renew the token when it expires.
    const value = auth.value.trim();
    if (value.startsWith('{')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new Error('cursor oauth_token: credential blob is not valid JSON');
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof (parsed as Record<string, unknown>)['accessToken'] !== 'string' ||
        !(parsed as Record<string, unknown>)['accessToken']
      ) {
        throw new Error('cursor oauth_token: credential blob is missing a non-empty accessToken');
      }
      writeFile0600(authJson, value);
      return {};
    }
    // Bare token (no refresh/userId) → minimal login state, best-effort.
    writeFile0600(authJson, JSON.stringify({ accessToken: value }));
    return {};
  },
};

/**
 * The managed-provider config kimi-code needs to run from an INJECTED OAuth
 * credential WITHOUT a `kimi login`. Written verbatim to `~/.kimi-code/config.toml`.
 *
 * ⚠️ Regression fix (kimi 0.23.5, 2026-07-11, live-verified on a real codespace):
 * v2.60.30 / PR #1329 removed `provisionKimiConfig` on the belief that "the
 * credential blob suffices + kimi defaults to a managed model". That held on
 * 0.23.4 but is FALSE on 0.23.5: the credential now AUTHENTICATES (ACP
 * `session/new ← ok`) but the config starts EMPTY, so `kimi provider list` shows
 * "No providers configured" and every `session/prompt` returns `end_turn` with
 * ZERO output ("No model configured"). The two-failure trap: running `kimi login`
 * to populate the config device-flow-WIPES the credential → "Authentication
 * required". So we must WRITE the config (never run `kimi login`).
 *
 * Reverse-engineered from the 0.23.5 binary + validated live (`kimi doctor config`
 * OK, `kimi -p` returns real text, ACP `session/prompt` streams chunks):
 *   - Managed provider name is the literal `managed:kimi-code`; `type = "kimi"`.
 *   - `base_url` = DEFAULT_KIMI_CODE_BASE_URL (overridable via `KIMI_CODE_BASE_URL`).
 *   - The `[...oauth]` ref points at the on-disk credential slot `oauth/kimi-code`
 *     (storage="file") authed against `oauthHost = https://auth.kimi.com`; kimi
 *     reads/refreshes `~/.kimi-code/credentials/kimi-code.json` through it.
 *   - `default_model` MUST resolve to a `[models."…"]` alias or the prompt fails.
 *     `kimi-k2` is the managed model (256K context).
 *
 * ⚠️ Version-sensitivity: the `kimi-k2` model id + `managed:kimi-code` provider
 * shape are 0.23.5-specific. If a future kimi renames the managed model this must
 * change (or the alias/default_model must be refreshed). Keep it byte-for-byte in
 * sync with the codespace snippet in api-v2 `codespaces/agent.ts`.
 */
const KIMI_MANAGED_CONFIG_TOML = `default_model = "kimi-k2"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"
oauthHost = "https://auth.kimi.com"

[models.kimi-k2]
provider = "managed:kimi-code"
model = "kimi-k2"
max_context_size = 262144
`;

const kimiProvisioner: AgentProvisioner = {
  write(auth, home): Record<string, string> {
    // Kimi's OAuth device-flow login-state is a per-provider JSON file named
    // `kimi-code.json`. kimi-cli reads `~/.kimi/credentials/kimi-code.json`
    // (reverse-engineered + verified live); the newer Kimi Code CLI uses
    // `~/.kimi-code/credentials/`. Write/clean BOTH so whichever binary is
    // installed picks up the same token.
    const credentialsFiles = [
      path.join(home, '.kimi', 'credentials', 'kimi-code.json'),
      path.join(home, '.kimi-code', 'credentials', 'kimi-code.json'),
    ];

    if (auth.kind === 'api_key') {
      // Shipping path: `kimi acp` reads the key from KIMI_API_KEY (+ optional
      // KIMI_BASE_URL, default https://api.moonshot.ai/v1). Remove any stale
      // login-state file so it can't shadow the freshly-provisioned key.
      credentialsFiles.forEach(rmIfExists);
      return { KIMI_API_KEY: auth.value };
    }

    // oauth_token → the captured device-flow blob (the RFC 8628
    // {access_token,refresh_token,expires_at,scope,token_type,expires_in} the
    // backend KimiOAuthProvider produces), written verbatim. Must NOT go in
    // KIMI_API_KEY.
    //
    // ⚠️ ACP LOGIN-STATE SLOT (root cause of the 2026-07-11 "-32000 Authentication
    // required" ACP incident — live-verified on a real codespace): the config's
    // oauth ref `storage="file" key="oauth/kimi-code"` does NOT resolve to
    // `~/.kimi-code/oauth/`. The 0.23.5 binary's `resolveKimiTokenStorageName`
    // STRIPS the `oauth/` prefix → storage name `kimi-code`, and `FileTokenStorage`
    // reads `<name>.json` from the credentials dir → the token MUST be
    // `~/.kimi-code/credentials/kimi-code.json`. `kimi acp` reads/refreshes THIS
    // file for auth (strace-confirmed) and streams a real session/prompt reply from
    // it; writing the blob to a bare `~/.kimi-code/oauth/kimi-code` slot instead →
    // session/new → -32000 (proven both ways in an isolated $KIMI_CODE_HOME). Do NOT
    // "move" this to an oauth/ slot — credentialsFiles below IS the ACP login state.
    credentialsFiles.forEach((f) => writeFile0600(f, auth.value));
    // ⚠️ Do NOT run `kimi login` to "provision config.toml" — it device-flow-WIPES
    // the credential (see the two-failure trap in KIMI_MANAGED_CONFIG_TOML). Instead
    // WRITE the managed-provider config the injected credential needs so kimi
    // resolves a provider + default_model without a login. This is the
    // `provisionKimiConfig` that PR #1329 (v2.60.30) removed — brought back as a
    // config-WRITE, byte-for-byte matched to the codespace snippet in api-v2.
    // The 0.23.5 CLI reads `~/.kimi-code/config.toml`.
    writeFile0600(path.join(home, '.kimi-code', 'config.toml'), KIMI_MANAGED_CONFIG_TOML);
    return {};
  },
};

const coderabbitProvisioner: AgentProvisioner = {
  write(auth, home): Record<string, string> {
    const dir = path.join(home, '.coderabbit');
    const authJson = path.join(dir, 'auth.json');
    if (auth.kind === 'api_key') {
      // A CodeRabbit API key → `coderabbit review` takes it via `--api-key`;
      // export CODERABBIT_API_KEY so the review handler passes it through.
      // Remove any stale login-state so it can't shadow the key.
      rmIfExists(authJson);
      return { CODERABBIT_API_KEY: auth.value };
    }
    // oauth_token → the FILENAME-AGNOSTIC {file, contents} envelope captured by
    // `diffCapturedCredential` at link time (whatever `coderabbit auth login`
    // wrote under ~/.coderabbit on the user's machine — its exact name isn't
    // documented and may shift). Restore it VERBATIM so `coderabbit review`
    // reads the logged-in credential. We never parse the token internals (it's
    // an opaque, non-expiring encrypted blob).
    const value = auth.value.trim();
    let file = 'auth.json';
    let contents = value;
    if (value.startsWith('{')) {
      try {
        const parsed = JSON.parse(value) as { file?: unknown; contents?: unknown };
        if (typeof parsed.file === 'string' && typeof parsed.contents === 'string') {
          file = path.basename(parsed.file); // sanitise — never escape ~/.coderabbit
          contents = parsed.contents;
        }
      } catch {
        /* not our envelope → write the raw value to auth.json */
      }
    }
    writeFile0600(path.join(dir, file), contents);
    return {};
  },
};

const opencodeProvisioner: AgentProvisioner = {
  write(auth): Record<string, string> {
    // opencode is model-agnostic and AUTO-DETECTS provider keys from env vars
    // (like aider). The credential is the user's provider key — detect the
    // provider by prefix and export the matching var; opencode picks it up.
    const key = auth.value.trim();
    const envName = key.startsWith('sk-ant-')
      ? 'ANTHROPIC_API_KEY'
      : key.startsWith('AIza')
        ? 'GEMINI_API_KEY'
        : 'OPENAI_API_KEY';
    return { [envName]: key };
  },
};

const PROVISIONERS: Partial<Record<AgentId, AgentProvisioner>> = {
  claude: claudeProvisioner,
  kimi: kimiProvisioner,
  codex: codexProvisioner,
  gemini: geminiProvisioner,
  cursor: cursorProvisioner,
  coderabbit: coderabbitProvisioner,
  opencode: opencodeProvisioner,
};

/** Raised when a deploy targets an agent we can't provision on the box. */
export class UnsupportedAgentError extends Error {
  readonly agentId: string;
  constructor(agentId: string) {
    super(`Self-hosted provisioning is not implemented for agent "${agentId}"`);
    this.name = 'UnsupportedAgentError';
    this.agentId = agentId;
  }
}

/**
 * Write the agent credential to disk for `publicAgentId`, returning the
 * env vars the spawned child should carry (non-empty only for the
 * `api_key` path). `homeDir` defaults to the real home but is injectable
 * for tests.
 */
export function provisionAgentCredentials(
  publicAgentId: string,
  auth: AgentAuth,
  homeDir: string = os.homedir(),
): Record<string, string> {
  const internal = toInternalAgentId(publicAgentId);
  if (!internal) throw new UnsupportedAgentError(publicAgentId);
  const provisioner = PROVISIONERS[internal];
  if (!provisioner) throw new UnsupportedAgentError(publicAgentId);
  return provisioner.write(auth, homeDir);
}
