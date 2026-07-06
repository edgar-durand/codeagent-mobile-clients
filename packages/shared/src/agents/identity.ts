/**
 * Agent identity — the ONE place the public (`LinkedAgentId`) and internal
 * (`AgentId`) id spaces are declared and bridged, plus the ONE alias
 * normalizer every surface funnels through.
 *
 * Canonical values consolidated from (Phase 2, PR-1):
 *   - backend `apps/api-v2/src/linked-agents/agent-map.ts`
 *     (`PUBLIC_TO_INTERNAL` / `INTERNAL_TO_PUBLIC` / `LinkedAgentId`),
 *   - CLI `apps/cli/src/commands/host/agent-provisioning.ts`
 *     (`PUBLIC_TO_INTERNAL_AGENT`),
 *   - VS Code plugin `apps/vsc-plugin/src/utils/cli-agent-id.ts`
 *     (marketplace aliases + `__terminal__:` strip),
 *   - CLI `apps/cli/src/commands/start/handlers.ts`
 *     (the `claude_code` → `claude` normalization),
 *   - mobile `apps/mobile/src/lib/agent-id-map.ts`.
 */

import type { AgentId, HeadroomKind } from './types';
import { AGENT_REGISTRY, isKnownAgentId } from './registry';

// ─── House agent constants ───────────────────────────────────────────────────
// Byte-identical mirrors of the backend repo's canonical
// `codeagent-mobile/packages/shared/src/constants/house-agent.ts` (which the
// api-v2 additionally hand-mirrors in `common/constants/house-agent.ts`).
// PR-3 replaces those copies with re-exports of THESE.

/** Sentinel id for the synthetic "CodeAgent Cloud (incluido)" house agent. */
export const HOUSE_AGENT_ID = 'house-codeagent-cloud';

/** Internal provider discriminator for the house agent. */
export const HOUSE_AGENT_PROVIDER = 'codeagent_cloud';

/** White-label display strings — never mention the backend model. */
export const HOUSE_AGENT_NAME = 'CodeAgent Cloud';
export const HOUSE_AGENT_VENDOR = 'CodeAgent';
export const HOUSE_AGENT_SUBTITLE = 'Included — no setup';

// ─── Public (LinkedAgent) id space ───────────────────────────────────────────

/**
 * Public-facing linked-agent ids — the id space the `/api/agents/...`
 * endpoints and the mobile/web surfaces speak. The internal `AgentId`
 * (`'claude' | 'codex' | …`) is what the runtimes / provisioning key on.
 */
export type LinkedAgentId =
  | 'claude_code'
  | 'codex'
  | 'cursor'
  | 'aider'
  | 'coderabbit'
  | 'gemini'
  | typeof HOUSE_AGENT_ID;

export const LINKED_AGENT_IDS: readonly LinkedAgentId[] = [
  'claude_code',
  'codex',
  'cursor',
  'aider',
  'coderabbit',
  'gemini',
  HOUSE_AGENT_ID,
];

export function isLinkedAgentId(value: string): value is LinkedAgentId {
  return (LINKED_AGENT_IDS as readonly string[]).includes(value);
}

/**
 * Every public id → internal `AgentId`.
 *
 * ⚠️ RECONCILED ASYMMETRY — this map is the UNION of what the two sides
 * historically accepted:
 *   - The backend's `agent-map.ts` accepts only the `LinkedAgentId` union
 *     (incl. the house agent, whose runtime is Claude Code) — no bare
 *     `claude`, no `copilot` (there is no public copilot LinkedAgentId).
 *   - The CLI's self-hosted `agent-provisioning.ts` additionally accepts
 *     bare `'claude'` and `'copilot'` (deploy payloads have carried
 *     already-internal ids), but not the house agent.
 * Consumers that must REJECT ids outside their own historical set keep
 * their own guard on top (e.g. `isLinkedAgentId`).
 */
export const PUBLIC_TO_INTERNAL: Readonly<
  Record<LinkedAgentId | 'claude' | 'copilot', AgentId>
> = {
  claude_code: 'claude',
  // CLI-side extra: self-hosted deploy payloads may carry the internal id.
  claude: 'claude',
  codex: 'codex',
  // CLI-side extra: copilot has no public LinkedAgentId (backend doesn't
  // expose it) but the self-hosted path accepts it.
  copilot: 'copilot',
  cursor: 'cursor',
  aider: 'aider',
  coderabbit: 'coderabbit',
  gemini: 'gemini',
  // The house agent runs Claude Code under the hood (pointed at the
  // MiniMax proxy). Its internal runtime is therefore `claude`.
  [HOUSE_AGENT_ID]: 'claude',
};

/**
 * Internal → public. Partial: `copilot` has no public LinkedAgentId, and
 * `claude` maps back to `claude_code` (never the house agent — that
 * direction is intentionally lossy).
 */
export const INTERNAL_TO_PUBLIC: Readonly<Partial<Record<AgentId, LinkedAgentId>>> = {
  claude: 'claude_code',
  codex: 'codex',
  cursor: 'cursor',
  aider: 'aider',
  coderabbit: 'coderabbit',
  gemini: 'gemini',
};

function isPublicToInternalKey(v: string): v is LinkedAgentId | 'claude' | 'copilot' {
  // Not Object.hasOwn — the VS Code plugin's tsconfig lib predates ES2022.
  return Object.prototype.hasOwnProperty.call(PUBLIC_TO_INTERNAL, v);
}

/** Resolve a public/linked id to the internal `AgentId`, or null. */
export function publicToInternal(publicId: string): AgentId | null {
  return isPublicToInternalKey(publicId) ? PUBLIC_TO_INTERNAL[publicId] : null;
}

/** Resolve an internal `AgentId` to its public `LinkedAgentId`, or null. */
export function internalToPublic(internal: AgentId): LinkedAgentId | null {
  return INTERNAL_TO_PUBLIC[internal] ?? null;
}

// ─── Alias normalization ─────────────────────────────────────────────────────

/** Prefix IDE plugins use for terminal-hosted agent ids. */
export const TERMINAL_AGENT_PREFIX = '__terminal__:';

/**
 * Known aliases → internal `AgentId`. Union of every alias set that used
 * to live scattered across the surfaces: the public `claude_code` id, the
 * VS Code / Open VSX marketplace extension ids, and JetBrains plugin ids.
 */
const AGENT_ID_ALIASES: Readonly<Record<string, AgentId>> = {
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

/**
 * THE agent-id normalizer. Collapses every known spelling of an agent id
 * (registry id, public `claude_code` form, marketplace extension id,
 * `__terminal__:`-prefixed plugin id — case/whitespace tolerant) onto the
 * internal `AgentId`, or `null` when unknown.
 *
 * Deliberately does NOT:
 *   - gate on `enabled` (callers that need availability check the
 *     registry — see the VS Code wrapper `normalizeCliAgentId`);
 *   - map the house agent (that's a runtime substitution, not an alias —
 *     use {@link publicToInternal});
 *   - fall back to anything. Unknown in → `null` out.
 */
export function normalizeAgentId(raw: string): AgentId | null {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return null;

  if (isKnownAgentId(value)) return value;

  const unprefixed = value.startsWith(TERMINAL_AGENT_PREFIX)
    ? value.slice(TERMINAL_AGENT_PREFIX.length)
    : value;
  if (isKnownAgentId(unprefixed)) return unprefixed;

  return AGENT_ID_ALIASES[unprefixed] ?? null;
}

// ─── Headroom kind derivation ────────────────────────────────────────────────

/**
 * The `headroom init --global <kind>` subcommand for an agent id, derived
 * from the registry's `headroomKind` flags — or `null` for unknown or
 * non-wrappable agents (cursor / gemini / aider / anything else).
 *
 * ⚠️ NEVER falls back to `'claude'`. The historical CLI fallback is how
 * the 2026-06 Cursor incident happened: an unsupported agent slipped
 * through, defaulted to `claude`, and `headroom wrap claude` launched
 * Claude Code instead of the user's agent. Callers that genuinely need a
 * default (e.g. picking an init subcommand AFTER the wrappable gate has
 * already passed) apply it themselves — see the CLI's
 * `agentIdToHeadroomKind` wrapper.
 *
 * Matching mirrors the historical predicates on BOTH sides (CLI
 * `isHeadroomSupportedAgent`, api-v2 `isHeadroomWrappableAgent`):
 * case-insensitive, `_`/`-` tolerant, prefix match — so `claude_code`,
 * `Claude-Code`, `codex_cli`, `copilot-cli` all resolve.
 */
export function headroomKindFor(agentId: string): HeadroomKind | null {
  const normalized = (agentId ?? '').toLowerCase().replace(/[_-]/g, '');
  if (!normalized) return null;
  for (const meta of Object.values(AGENT_REGISTRY)) {
    if (meta.headroomKind !== undefined && normalized.startsWith(meta.id)) {
      return meta.headroomKind;
    }
  }
  return null;
}

/**
 * Registry-derived replacement for the two scattered predicates
 * (`isHeadroomSupportedAgent` in the CLI, `isHeadroomWrappableAgent` in
 * api-v2). Accepts both id spaces (`claude_code` and `claude`).
 */
export function isHeadroomWrappable(agentId: string): boolean {
  return headroomKindFor(agentId) !== null;
}
