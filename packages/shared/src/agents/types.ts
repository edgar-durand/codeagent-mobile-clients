export type AgentId =
  | 'claude'
  | 'codex'
  | 'copilot'
  | 'coderabbit'
  | 'cursor'
  | 'aider'
  | 'gemini';

export type AgentAuthKind = 'oauth_token' | 'api_key' | 'setup_token';

/**
 * The agent kinds Headroom (the token-compression proxy) can actually
 * wrap/route — the exact subcommands `headroom init --global <kind>`
 * accepts. NOT an alias of {@link AgentId}: cursor / gemini / aider run
 * native (Headroom disabled) because `headroom init` has no recipe that
 * routes them.
 */
export type HeadroomKind = 'claude' | 'codex' | 'copilot';

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
  /**
   * Whether Headroom can wrap/route this agent (claude / codex / copilot
   * only). Canonical truth previously scattered across two prefix-matching
   * predicates: `isHeadroomSupportedAgent` (CLI `host-agent.ts`) and
   * `isHeadroomWrappableAgent` (api-v2 `codespaces/headroom.ts`). When
   * false the agent MUST run native — wrapping an unsupported agent
   * mislaunches it as Claude (the 2026-06 Cursor incident).
   */
  headroomWrappable: boolean;
  /**
   * The `headroom init --global <kind>` subcommand for this agent.
   * Present iff {@link headroomWrappable} is true.
   */
  headroomKind?: HeadroomKind;
  /**
   * Whether the agent runs over ACP (Agent Client Protocol) in the CLI —
   * mirrors which agents have an entry in the CLI's ACP adapter registry
   * (`apps/cli/src/agents/acp/adapters.ts`). `false` ⇒ legacy PTY runtime.
   */
  acp: boolean;
  /**
   * `true` for agents that authorize via the OAuth DEVICE-code flow
   * (Codex, Cursor) rather than the redirect/paste flow (Claude, Gemini).
   * Mirrors the mobile agent catalog (`apps/mobile/src/lib/agentCatalog.ts`).
   */
  deviceFlow?: boolean;
  /**
   * Whether the device-code flow surfaces `userCode` to the user as an
   * "enter this code" string. `true` for Codex (a real human-typed
   * user_code shown on the OpenAI page). `false` for Cursor — there
   * `userCode` is the secret PKCE verifier used only for the poll
   * echo-back; rendering it would leak the secret. Only meaningful when
   * {@link deviceFlow} is `true`.
   */
  showsUserCode?: boolean;
}
