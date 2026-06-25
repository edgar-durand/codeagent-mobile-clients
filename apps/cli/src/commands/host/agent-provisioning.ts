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
import type { AgentAuth, AgentId } from '@codeagent/shared';

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
  fs.chmodSync(filePath, 0o600);
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

const PROVISIONERS: Partial<Record<AgentId, AgentProvisioner>> = {
  claude: claudeProvisioner,
  codex: codexProvisioner,
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
