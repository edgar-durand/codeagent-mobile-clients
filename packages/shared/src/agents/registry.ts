import type { AgentId, AgentMetadata } from './types';

export const AGENT_REGISTRY: Record<AgentId, AgentMetadata> = {
  claude: {
    id: 'claude',
    displayName: 'Claude Code',
    binaryName: 'claude',
    enabled: true,
    // Mirrors the backend registry (codeagent-mobile
    // apps/api-v2/src/codespaces/agent.ts — authoritative for auth
    // capabilities). `setup_token` is the bare `sk-ant-oat01-…` from
    // `claude setup-token` → delivered via CLAUDE_CODE_OAUTH_TOKEN.
    supportedAuthKinds: ['setup_token', 'oauth_token', 'api_key'],
    preferredAuthKind: 'setup_token',
    headroomWrappable: true,
    headroomKind: 'claude',
    // npm adapter `@agentclientprotocol/claude-agent-acp`.
    acp: true,
  },
  codex: {
    id: 'codex',
    displayName: 'Codex CLI',
    binaryName: 'codex',
    enabled: true,
    supportedAuthKinds: ['oauth_token', 'api_key'],
    preferredAuthKind: 'oauth_token',
    headroomWrappable: true,
    headroomKind: 'codex',
    // npm adapter `@agentclientprotocol/codex-acp`.
    acp: true,
    // OAuth device-code flow; the user_code on the OpenAI page IS a real
    // human-typed code — surfaces render it (with a copy affordance).
    deviceFlow: true,
    showsUserCode: true,
  },
  copilot: {
    id: 'copilot',
    displayName: 'GitHub Copilot CLI',
    binaryName: 'gh',
    enabled: false,
    supportedAuthKinds: ['oauth_token'],
    preferredAuthKind: 'oauth_token',
    // `headroom init --global copilot` exists even though the agent is
    // still disabled here (no runtime builder yet).
    headroomWrappable: true,
    headroomKind: 'copilot',
    acp: false,
  },
  coderabbit: {
    id: 'coderabbit',
    displayName: 'CodeRabbit',
    binaryName: 'coderabbit',
    enabled: true,
    // CodeRabbit links via a CLI-driven LOOPBACK OAuth (`coderabbit auth
    // login --agent`): the CLI captures the token and hands it to the vault
    // through `linkFromCli` (method:'oauth'), same as the terminal handoff.
    // `oauth_token` is preferred; a real API key is still accepted as a
    // fallback. There is no backend PKCE provider — the loopback runs on the
    // user's own machine, so linking is always CLI-mediated.
    supportedAuthKinds: ['oauth_token', 'api_key'],
    preferredAuthKind: 'oauth_token',
    headroomWrappable: false,
    // Legacy PTY runtime — no ACP adapter registered.
    acp: false,
  },
  cursor: {
    id: 'cursor',
    displayName: 'Cursor Agent',
    binaryName: 'cursor-agent',
    enabled: true,
    // Backend registry is authoritative: since the Cursor OAuth
    // device-flow shipped, new links are oauth_token only (the login
    // blob written to ~/.config/cursor/auth.json). Legacy vaulted
    // api_key rows may still exist server-side, but the link surface
    // no longer offers api_key.
    supportedAuthKinds: ['oauth_token'],
    preferredAuthKind: 'oauth_token',
    // `headroom wrap cursor` is "manual/print-only" (IDE settings; the
    // headless cursor-agent CLI has no base-URL override) — runs native.
    headroomWrappable: false,
    // Native ACP server: `cursor-agent acp`.
    acp: true,
    // Reverse-engineered device/poll flow; `userCode` is the secret PKCE
    // verifier echoed back on poll — NEVER human-facing.
    deviceFlow: true,
    showsUserCode: false,
  },
  aider: {
    id: 'aider',
    displayName: 'Aider',
    binaryName: 'aider',
    enabled: true,
    // Aider is OAuth-less — auth is via ANTHROPIC_API_KEY / OPENAI_API_KEY
    // / etc. env vars or `~/.aider.conf.yml`. The link flow surfaces
    // this via the existing --api-key escape hatch in commands/link.ts.
    supportedAuthKinds: ['api_key'],
    preferredAuthKind: 'api_key',
    headroomWrappable: false,
    // Legacy PTY runtime — no ACP adapter registered.
    acp: false,
  },
  gemini: {
    id: 'gemini',
    displayName: 'Gemini CLI',
    binaryName: 'gemini',
    enabled: true,
    // OAuth via `gemini auth login` (captured by `codeam link gemini`
    // from ~/.gemini/oauth_creds.json) AND GEMINI_API_KEY are both
    // accepted by the backend's GeminiProvisioningStrategy and propagated
    // into codespace deploys.
    supportedAuthKinds: ['oauth_token', 'api_key'],
    preferredAuthKind: 'oauth_token',
    // Not listed by `headroom wrap --help` — runs native.
    headroomWrappable: false,
    // Native ACP server: `gemini --skip-trust --acp`.
    acp: true,
  },
  kimi: {
    id: 'kimi',
    displayName: 'Kimi Code',
    binaryName: 'kimi',
    enabled: true,
    // API key (KIMI_API_KEY, + optional KIMI_BASE_URL) is the shipping auth —
    // fully documented, no reverse-engineering. OAuth `/login` (login-state at
    // ~/.kimi-code/credentials/<name>.json, base https://api.kimi.com/coding/)
    // is declared so it can land later without a wire change, but capturing
    // that blob server-side is a separate reverse-engineering spike (phase 2).
    supportedAuthKinds: ['api_key', 'oauth_token'],
    preferredAuthKind: 'api_key',
    // Moonshot's `kimi` is not listed by `headroom wrap --help` — runs native.
    headroomWrappable: false,
    // Native ACP server: `kimi acp` (stdio JSON-RPC, answers `initialize`).
    acp: true,
  },
};

export function getEnabledAgents(): AgentMetadata[] {
  return Object.values(AGENT_REGISTRY).filter(m => m.enabled);
}

export function getAgent(id: AgentId): AgentMetadata {
  const meta = AGENT_REGISTRY[id];
  if (!meta) throw new Error(`Unknown agent id: ${id}`);
  return meta;
}

export function isKnownAgentId(id: string): id is AgentId {
  return id in AGENT_REGISTRY;
}
