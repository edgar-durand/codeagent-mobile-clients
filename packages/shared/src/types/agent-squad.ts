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
  /**
   * Autonomous mode (P2-2): the CLI accepted this proposal ITSELF instead of
   * emitting the tap-to-accept card. Mobile renders a passive timeline notice
   * for `auto: true`, never the accept card. Absent = the v1 card flow.
   */
  auto?: boolean;
  /**
   * Hops left in the chain AFTER this one (`auto` only) — the hop is already
   * spent when this is emitted, so `0` means "this is the last auto hop; any
   * further proposal falls back to the card". Mobile renders it verbatim as
   * "<n> hops left".
   */
  hopsRemaining?: number;
}

/** `handoff_resolved` event payload. `auto` mirrors {@link HandoffProposal}. */
export interface HandoffResolution {
  proposalId: string;
  accepted: boolean;
  auto?: boolean;
}

// ─── Autonomous chained handoffs (P2-2, PRO) ───────────────────────────────

/** Relay command: read/write the session's autonomous-handoff mode. */
export const SQUAD_CONFIGURE_COMMAND = 'squad_configure';
/** Relay command: per-member activity for the "Squad activity" screen. */
export const SQUAD_STATS_COMMAND = 'squad_stats';

export const SQUAD_HOP_BUDGET_DEFAULT = 3;
export const SQUAD_HOP_BUDGET_MIN = 1;
export const SQUAD_HOP_BUDGET_MAX = 10;

/**
 * Clamp a caller-supplied hop budget into the supported range, falling back to
 * the default for a missing / non-finite value. The ONE place the bound lives —
 * the CLI's config mutator and its `squad_configure` handler both call it.
 */
export function clampHopBudget(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return SQUAD_HOP_BUDGET_DEFAULT;
  return Math.min(SQUAD_HOP_BUDGET_MAX, Math.max(SQUAD_HOP_BUDGET_MIN, Math.round(value)));
}

/** Persisted per-session autonomous-handoff mode. Default OFF. */
export interface SquadAutoConfig {
  enabled: boolean;
  hopBudget: number;
}

export type SquadConfigurePayload =
  { action: 'set'; autoHandoffs: boolean; hopBudget?: number } | { action: 'status' };

/** Ack of {@link SQUAD_CONFIGURE_COMMAND} — the state AFTER the command. */
export interface SquadConfigureResult extends SquadAutoConfig {
  /** Hops left in the current chain (resets on every user prompt). */
  hopsRemaining: number;
}

export interface SquadMemberActivity {
  agentId: string;
  turns: number;
  /** DISTINCT paths this member touched across its journaled turns. */
  filesTouched: number;
}

/** Ack of {@link SQUAD_STATS_COMMAND}. No cost attribution in v1. */
export interface SquadStatsResult {
  members: SquadMemberActivity[];
  handoffs: { proposed: number; accepted: number; auto: number };
  sinceTurn: number;
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
