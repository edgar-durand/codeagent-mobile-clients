export type AgentId = 'claude' | 'codex' | 'copilot' | 'coderabbit';

export type AgentAuthKind = 'oauth_token' | 'api_key';

export interface AgentAuth {
  kind: AgentAuthKind;
  /** API key plain, or JSON serialized for oauth_token. Interpretation depends on the agent. */
  value: string;
}

export interface AgentModel {
  id: string;
  label: string;
  contextWindow: number;
  pricing?: {
    inputPerM: number;
    outputPerM: number;
    cacheReadPerM?: number;
    cacheCreationPerM?: number;
  };
}

export interface NormalizedMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  text: string;
  timestamp: string;
  modelId?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheCreation?: number;
  };
}

export interface AgentMetadata {
  id: AgentId;
  displayName: string;
  binaryName: string;
  enabled: boolean;
  supportedAuthKinds: AgentAuthKind[];
  preferredAuthKind: AgentAuthKind;
}
