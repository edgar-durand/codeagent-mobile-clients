/**
 * Session agent switch — wire types for the `switch_agent` relay command and
 * its progress/status SSE events.
 *
 * A live session can swap its coding agent (e.g. claude → codex) in-process:
 * mobile sends `switch_agent { agentId }` over the command relay; the CLI
 * pulls the vaulted credential (+ install script when the binary is missing),
 * restarts the ACP client on the new adapter, and reports progress via
 * `POST /api/agent-switch/events` → the per-user SSE bus
 * (`switch_agent_progress` / `switch_agent_status`).
 *
 * CANONICAL WIRE OWNER: this file (`@codeam/shared`), per the cross-repo
 * rule. The backend/mobile repo consumes it through the published package.
 *
 * Continuity contract: the conversation does NOT resume cross-agent (ACP
 * `session/load` ids are per-agent). Instead the CLI captures a bounded tail
 * of the prior conversation and prefixes it to the first post-switch prompt
 * (the "context handoff"), so the new agent continues with the session's
 * context in a fresh conversation.
 */

/** Relay command type mobile sends to switch the session's agent. */
export const SWITCH_AGENT_COMMAND = 'switch_agent';

/** Payload of the `switch_agent` relay command. */
export interface SwitchAgentCommand {
  /** Public agent id to switch to (catalog id, e.g. 'codex'). */
  agentId: string;
}

/**
 * Install-progress milestone emitted on the `switch_agent_progress` SSE event
 * while a switch is running. Must stay aligned with the backend's validator
 * (`apps/api-v2/src/agent-switch/agent-switch.controller.ts`) and the mobile
 * store — the backend 400s on any value outside this set.
 *
 * - `credential` — fetching + writing the vaulted credential for the target.
 * - `install`    — target binary missing; running its install script.
 * - `restart`    — old client stopped; new adapter starting (`session/new`).
 */
export type SwitchAgentStep = 'credential' | 'install' | 'restart';

/**
 * Terminal/steady switch state — carried on `switch_agent_status` and used by
 * mobile to flip the session's agent chip (`ready`) or render an actionable
 * error (`error`). `switching` is published once up-front so other paired
 * devices see the transition too.
 */
export interface SwitchAgentStatus {
  state: 'switching' | 'ready' | 'error';
  /** Target public agent id of the switch. */
  agentId: string;
  /** Public agent id that was running before the switch was attempted. */
  fromAgentId?: string;
  /** Human-readable reason when `state === 'error'`. */
  error?: string;
}

/** Result payload the CLI acks the `switch_agent` command with. */
export interface SwitchAgentResult {
  ok: boolean;
  agentId: string;
  /** Set when `ok === false`. */
  error?: string;
}
