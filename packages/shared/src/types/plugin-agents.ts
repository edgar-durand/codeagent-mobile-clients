/**
 * The agents report — `POST /api/plugin/agents` (plugin → backend) and
 * `GET /api/plugin/agents?pluginId=` (app → backend).
 *
 * CANONICAL WIRE OWNER: this file (`@codeam/shared`), per the cross-repo rule.
 * The backend stores each entry verbatim and hands it back to the app.
 */

/**
 * Whether the reported agent can actually answer a prompt on this host.
 *
 * WHY (codeagent-04jp, 2026-10-02): a local session whose agent could not run
 * (Claude Code not signed in on the user's computer) read "The host isn't
 * responding" in the app — the only signal was silence. The plugin now says
 * what it knows, so the app can offer the real fix ("sign in on your computer"
 * or "use CodeAgent credits instead").
 *
 * - `ready`         — the agent started and accepted a session.
 * - `not_installed` — the agent's binary/adapter is missing on the host.
 * - `not_signed_in` — the agent is installed but has no usable login/key.
 * - `failed`        — it was installed and signed in, and still failed to start.
 *
 * Optional on the wire: older plugins never send it, and its absence means
 * "unknown", never `ready`.
 */
export const PLUGIN_AGENT_STATUSES = ['ready', 'not_installed', 'not_signed_in', 'failed'] as const;

export type PluginAgentStatus = (typeof PLUGIN_AGENT_STATUSES)[number];

export function isPluginAgentStatus(x: unknown): x is PluginAgentStatus {
  return typeof x === 'string' && (PLUGIN_AGENT_STATUSES as readonly string[]).includes(x);
}

/** One entry of the agents report. */
export interface PluginAgentReport {
  /** Runtime agent id (`claude`, `codex`, …) — NOT the public linked id. */
  id: string;
  name: string;
  /** Icon key — the apps key their logo map by agent id. */
  icon: string;
  installed: boolean;
  isTerminal?: boolean;
  /** See {@link PluginAgentStatus}. Absent = unknown (older plugin). */
  status?: PluginAgentStatus;
}
