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

const claudeProvisioner: AgentProvisioner = {
  write(auth, home): Record<string, string> {
    if (auth.kind === 'api_key') {
      // Claude reads the raw key from ANTHROPIC_API_KEY. No file.
      return { ANTHROPIC_API_KEY: auth.value };
    }
    // oauth_token → the value is the FULL contents of
    // ~/.claude/.credentials.json (the JSON the local link flow
    // captured), written verbatim. Mirrors the backend snippet.
    writeFile0600(path.join(home, '.claude', '.credentials.json'), auth.value);
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
    return {};
  },
};

const codexProvisioner: AgentProvisioner = {
  write(auth, home): Record<string, string> {
    if (auth.kind === 'api_key') {
      return { OPENAI_API_KEY: auth.value };
    }
    // oauth_token → ~/.codex/auth.json verbatim.
    writeFile0600(path.join(home, '.codex', 'auth.json'), auth.value);
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
