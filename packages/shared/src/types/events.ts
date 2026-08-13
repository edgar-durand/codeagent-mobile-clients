/**
 * Canonical names of the per-user SSE bus events (`/api/users/me/stream`).
 *
 * The authoritative list is the `UserEvent` discriminated union in the
 * backend repo: codeagent-mobile/apps/api-v2/src/user-events/user-events.types.ts.
 * Every `type:` literal of that union appears here exactly once — when a new
 * variant lands on the union, add its name here (and in the backend mirror of
 * this file at codeagent-mobile/packages/shared/src/types/events.ts).
 *
 * Producers (CLI event posts, backend `userEvents.publish` calls) and
 * consumers (the `useUserEventsSSE` hooks' switch cases) should reference
 * `USER_EVENTS.*` instead of re-typing the string, so a typo becomes a
 * compile error instead of a silently dropped event.
 */
export const USER_EVENTS = {
  PAIRED_SESSION_STATUS: 'paired_session_status',
  PAIRED_SESSION_ADDED: 'paired_session_added',
  PAIRED_SESSION_REMOVED: 'paired_session_removed',
  PAIRED_SESSION_BRANCH_CHANGED: 'paired_session_branch_changed',
  SHARED_WITH_ME_ADDED: 'shared_with_me_added',
  SHARED_WITH_ME_REVOKED: 'shared_with_me_revoked',
  USAGE_CHANGED: 'usage_changed',
  TASK_DONE: 'task_done',
  HUNK_PENDING_REVIEW_ADDED: 'hunk_pending_review_added',
  HUNK_REVIEW_RESOLVED: 'hunk_review_resolved',
  FILE_CHANGED: 'file_changed',
  FILES_BATCH_CHANGED: 'files_batch_changed',
  AGENT_STREAMING_CHUNK: 'agent_streaming_chunk',
  AGENT_AWAITING_ANSWER: 'agent_awaiting_answer',
  AWAITING_INPUT_ADDED: 'awaiting_input_added',
  AGENT_ANSWER_RESOLVED: 'agent_answer_resolved',
  TEMPLATE_ADDED: 'template_added',
  TEMPLATE_REMOVED: 'template_removed',
  TEMPLATE_UPDATED: 'template_updated',
  AGENT_TASK_DISPATCHED: 'agent_task_dispatched',
  AGENT_TASK_COMPLETED: 'agent_task_completed',
  LINKED_AGENT_ADDED: 'linked_agent_added',
  QUOTA_REACHED: 'quota_reached',
  LINKED_AGENT_LINK_FAILED: 'linked_agent_link_failed',
  CODESPACE_AGENT_INSTALLED: 'codespace_agent_installed',
  AGENT_CREDENTIALS_REFRESHED: 'agent_credentials_refreshed',
  CREDENTIAL_INVALID: 'credential_invalid',
  CODESPACE_WAKING: 'codespace_waking',
  CODESPACE_BILLING_BLOCKED: 'codespace_billing_blocked',
  COST_SAVING_UPDATED: 'cost_saving_updated',
  COMMAND_COMPLETED: 'command_completed',
  AI_SUMMARY_PENDING: 'ai_summary_pending',
  AI_SUMMARY_READY: 'ai_summary_ready',
  AI_INSIGHT_PENDING: 'ai_insight_pending',
  AI_INSIGHT_READY: 'ai_insight_ready',
  PUSH_TOKEN_INVALIDATED: 'push_token_invalidated',
  PREVIEW_DETECTION_PENDING: 'preview_detection_pending',
  PREVIEW_DETECTION_READY: 'preview_detection_ready',
  PREVIEW_STARTING: 'preview_starting',
  PREVIEW_READY: 'preview_ready',
  PREVIEW_STOPPED: 'preview_stopped',
  PREVIEW_ERROR: 'preview_error',
  PREVIEW_PROGRESS: 'preview_progress',
  BEADS_STATE_CHANGED: 'beads_state_changed',
  BEADS_PROVISIONING: 'beads_provisioning',
  BEADS_TEAM_MEMORY_CHANGED: 'beads_team_memory_changed',
  AUDIT_EVENT_ADDED: 'audit_event_added',
  SELF_HOSTED_HOST_ADDED: 'self_hosted_host_added',
  SELF_HOSTED_HOST_STATUS: 'self_hosted_host_status',
  SELF_HOSTED_HOST_REMOVED: 'self_hosted_host_removed',
  SELF_HOSTED_HOST_TELEMETRY: 'self_hosted_host_telemetry',
  SELF_HOSTED_HOST_METRICS: 'self_hosted_host_metrics',
  SELF_HOSTED_HOST_SESSIONS: 'self_hosted_host_sessions',
  SELF_HOSTED_DEPLOY_PROGRESS: 'self_hosted_deploy_progress',
  /** Fleet rescue: the user's CodeAgent Box reached RUNNING (host enrolled
   *  + online). Drives the mobile "Use a free CodeAgent Box" flow to
   *  auto-deploy the user's presets instead of hanging on a paired session
   *  a box never creates. */
  FLEET_BOX_READY: 'fleet_box_ready',
  REFERRAL_REWARD_EARNED: 'referral_reward_earned',
  HEADROOM_PROGRESS: 'headroom_progress',
  HEADROOM_STATUS: 'headroom_status',
  BEADS_STATUS: 'beads_status',
  LINKED_AGENT_HEADROOM_BUDGET_UPDATED: 'linked_agent_headroom_budget_updated',
  CLI_UPDATE_AVAILABLE: 'cli_update_available',
  AGENT_INSTALL_PROGRESS: 'agent_install_progress',
  AGENT_INSTALL_FAILED: 'agent_install_failed',
  CLI_UPDATE_PROGRESS: 'cli_update_progress',
  CLI_UPDATE_FAILED: 'cli_update_failed',
  BATON_STATE: 'baton_state',
  INTEGRATION_LINKED: 'integration_linked',
  INTEGRATION_UNLINKED: 'integration_unlinked',
  INTEGRATION_CREDENTIAL_INVALID: 'integration_credential_invalid',
  // Session Tools — add/remove Agent Toolkit integrations on an ALREADY-ACTIVE
  // session. The backend publishes SESSION_INTEGRATIONS_CHANGED after it persists
  // the new attached set + relays `integrations_sync` to the box (the CLI rewrites
  // the manifest + reprovisions the live agent, answered synchronously via the
  // command result). Drives live UI on the sending device AND any other paired
  // device on the same session. Mirrored in repo A. (`integrations_detect` is a
  // pure request/response over the relay — no event.)
  SESSION_INTEGRATIONS_CHANGED: 'session_integrations_changed',
  // CodeRabbit reviewer — the CLI posts these to /api/coderabbit/events; the
  // backend re-publishes them on the per-user SSE bus (mirrored in repo A).
  CODERABBIT_PROGRESS: 'coderabbit_progress',
  CODERABBIT_STATUS: 'coderabbit_status',
  CODERABBIT_REVIEW: 'coderabbit_review',

  // Session agent switch — the CLI posts these to /api/agent-switch/events
  // while a `switch_agent` relay command swaps the session's agent in-process;
  // the backend re-publishes them on the per-user SSE bus (mirrored in repo A).
  SWITCH_AGENT_PROGRESS: 'switch_agent_progress',
  SWITCH_AGENT_STATUS: 'switch_agent_status',

  // VCS / PR Command Center — the backend publishes this after an agent finishes
  // reviewing a PR (verdict + comment count + findings), driving the mobile
  // completion screen + push. Mirrored in repo A's app-shared events.ts.
  VCS_AGENT_REVIEW_COMPLETE: 'vcs_agent_review_complete',
  /** PR-review launch progress toast — the "Review with an agent" flow shows a
   *  toast when the review runs server-side (Inngest). Mobile-only surface,
   *  produced by api-v2 (the CLI neither produces nor consumes it). Mirrored in
   *  repo A. */
  PR_REVIEW_LAUNCH: 'pr_review_launch',
  /** Agent Packs — full `PackRunState` republished by the backend on every
   *  pipeline transition (stage start/done, pause, stall, completion). CLI
   *  posts to /api/packs/events; mobile's pack.store renders the pipeline.
   *  Mirrored in repo A's app-shared events.ts. */
  PACK_STATE: 'pack_state',
} as const;

export type UserEventName = (typeof USER_EVENTS)[keyof typeof USER_EVENTS];
