/**
 * Agent Squad wire types — @-mention routing, roster, and agent-proposed
 * handoffs. Canonical owner (api-v2 + mobile consume the published npm
 * package; the cm-repo packages/shared mirror re-exports).
 * Spec: docs/superpowers/specs/2026-08-13-agent-squad-mentions-handoffs-design.md
 */
import type { AgentId } from '../agents/types';

/** start_task payload — makes the previously-dead agentId field a real wire contract. */
export interface StartTaskPayload {
  prompt?: string;
  files?: Array<{ filename: string; base64?: string; mimeType?: string }>;
  /** Internal runtime id. Present + ≠ active agent → the runner swaps before running. */
  agentId?: string;
}

export interface SquadRosterAgent {
  agentId: string; // internal runtime id
  displayName: string;
}

/** Response data of POST /api/plugin/agents/roster. */
export interface SquadRosterData {
  agents: SquadRosterAgent[];
  handoffsEnabled: boolean;
}

/** The fence tag the active agent uses to propose a handoff (PRO). */
export const HANDOFF_FENCE_TAG = 'codeam-handoff';

export interface HandoffProposal {
  proposalId: string;
  fromAgentId: string;
  toAgentId: string;
  reason: string;
  prompt: string;
}

/** Per-agent specialty blurbs for the team preamble. Copy, not routing. */
export const SQUAD_SPECIALTIES: Readonly<Partial<Record<AgentId, string>>> = {
  claude: 'deep reasoning, refactors, and multi-step architecture work',
  codex: 'fast, focused implementation and test fixing',
  cursor: 'multi-file edits and codebase-wide changes',
  gemini: 'large-context analysis across big files and logs',
  kimi: 'long-context code reading and summarization',
  opencode: 'general implementation tasks',
};
