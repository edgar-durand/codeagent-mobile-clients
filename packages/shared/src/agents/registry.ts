import type { AgentId, AgentMetadata } from './types';

export const AGENT_REGISTRY: Record<AgentId, AgentMetadata> = {
  claude: {
    id: 'claude',
    displayName: 'Claude Code',
    binaryName: 'claude',
    enabled: true,
    supportedAuthKinds: ['oauth_token', 'api_key'],
    preferredAuthKind: 'oauth_token',
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
    supportedAuthKinds: ['oauth_token', 'api_key'],
    preferredAuthKind: 'oauth_token',
  },
  cursor: {
    id: 'cursor',
    displayName: 'Cursor Agent',
    binaryName: 'cursor-agent',
    enabled: true,
    supportedAuthKinds: ['oauth_token', 'api_key'],
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
    // Gemini speaks ACP natively via `gemini --acp` — pairing flows
    // through the ACP runtime, not a PTY parser. Auth is the user's
    // existing `gemini auth login` (OAuth) or GEMINI_API_KEY env var,
    // both managed by the gemini binary itself.
    supportedAuthKinds: ['api_key'],
    preferredAuthKind: 'api_key',
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
  return (
    id === 'claude' ||
    id === 'codex' ||
    id === 'copilot' ||
    id === 'coderabbit' ||
    id === 'cursor' ||
    id === 'aider' ||
    id === 'gemini'
  );
}
