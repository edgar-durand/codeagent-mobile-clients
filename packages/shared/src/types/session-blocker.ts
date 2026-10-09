import { z } from 'zod';

/**
 * Session blocker — a TYPED tag on the terminal chat bubble of a turn that
 * cannot run ("you're out of credits", "Cursor needs a paid plan", …).
 *
 * The bubble itself stays prose (every client renders it as markdown). This
 * tag rides NEXT to it on the `{type:'text', done:true}` output chunk as
 * `blocker`, so mobile/web can attach the right escape-route buttons from the
 * kind instead of regex-matching the CLI's wording — which drifted silently:
 * the apps matched "reached your daily CodeAgent Cloud limit" while the CLI
 * had long been saying "You’ve reached today’s agent usage limit", so the
 * CLI-built house-limit bubble never got its buttons (codeagent-gfip).
 *
 * CANONICAL WIRE OWNER: this file. The apps keep their regex only as the
 * fallback for chunks from CLIs that predate the tag.
 */
export const SESSION_BLOCKER_KINDS = [
  /** CodeAgent Cloud usage ceiling — PRO lifts it. */
  'house_agent_limit',
  /** CodeAgent Cloud down on OUR side — nothing to buy. */
  'house_agent_unavailable',
  /** The vendor (e.g. Cursor) needs a paid plan to run its agent. */
  'agent_plan_required',
  /** The user's own agent credentials are invalid/expired. */
  'agent_auth_failed',
  /** The prepaid CodeAgent wallet is empty. */
  'credits_exhausted',
  /** The user's OWN provider key (OpenRouter, …) has no balance. */
  'provider_credits_exhausted',
  /** The agent process died before it could open a session. */
  'agent_startup_failed',
] as const;

export type SessionBlockerKind = (typeof SESSION_BLOCKER_KINDS)[number];

export interface SessionBlocker {
  kind: SessionBlockerKind;
  /** Agent the blocker is about (registry id or label), when known. */
  agentId?: string;
  /** Provider name for `provider_credits_exhausted` (e.g. `OpenRouter`). */
  provider?: string;
}

export const SessionBlockerSchema = z.object({
  kind: z.enum(SESSION_BLOCKER_KINDS),
  agentId: z.string().min(1).max(64).optional(),
  provider: z.string().min(1).max(120).optional(),
});

/** Validate an untrusted `blocker` field off the wire; `null` when absent or malformed. */
export function toSessionBlocker(raw: unknown): SessionBlocker | null {
  const parsed = SessionBlockerSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
