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
  },
  codex: {
    id: 'codex',
    displayName: 'Codex CLI',
    binaryName: 'codex',
    enabled: true,
    supportedAuthKinds: ['oauth_token', 'api_key'],
    preferredAuthKind: 'oauth_token',
  },
  copilot: {
    id: 'copilot',
    displayName: 'GitHub Copilot CLI',
    binaryName: 'gh',
    enabled: false,
    supportedAuthKinds: ['oauth_token'],
    preferredAuthKind: 'oauth_token',
  },
  coderabbit: {
    id: 'coderabbit',
    displayName: 'CodeRabbit',
    binaryName: 'coderabbit',
    enabled: true,
    // Backend registry is authoritative: CodeRabbit links via a real
    // API key only (no OAuth flow exists in api-v2).
    supportedAuthKinds: ['api_key'],
    preferredAuthKind: 'api_key',
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
