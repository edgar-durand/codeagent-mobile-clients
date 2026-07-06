import { AGENT_REGISTRY, isKnownAgentId, type AgentId } from '@codeam/shared';

const CLI_AGENT_ALIASES: Record<string, AgentId> = {
  claude_code: 'claude',
  'claude-code': 'claude',
  'anthropic.claude-code': 'claude',
  'anthropics.claude': 'claude',
  'anthropic.claude-ce': 'claude',
  'anthropic.claude': 'claude',
  'com.anthropic.claudecode': 'claude',
  'com.anthropic.claude': 'claude',
  'openai.chatgpt': 'codex',
  'coderabbitai.coderabbit-vscode': 'coderabbit',
};

export function normalizeCliAgentId(raw: unknown): AgentId | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;

  if (isKnownAgentId(value) && AGENT_REGISTRY[value].enabled) return value;

  const terminalPrefix = '__terminal__:';
  const unprefixed = value.startsWith(terminalPrefix)
    ? value.slice(terminalPrefix.length)
    : value;

  if (isKnownAgentId(unprefixed) && AGENT_REGISTRY[unprefixed].enabled) {
    return unprefixed;
  }
  return CLI_AGENT_ALIASES[unprefixed] ?? null;
}
