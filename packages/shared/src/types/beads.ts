/**
 * Beads wire protocol — the bytes the codeam-cli pushes to the backend's
 * `POST /api/beads/ingest` and that the backend mirrors + fans out over the
 * per-user SSE bus.
 *
 * CANONICAL WIRE OWNER: this file (`@codeam/shared`) owns the wire
 * protocol, per the cross-repo rule. The backend repo keeps hand-synced
 * MIRRORS of these shapes (`codeagent-mobile/packages/shared/src/types/beads.ts`
 * for mobile/landing, `codeagent-mobile/apps/api-v2/src/beads/beads.types.ts`
 * for the backend service); a drift-check script at
 * `codeagent-mobile/scripts/check-shared-drift` compares them. Both the CLI
 * (tsup) and the VS Code extension (esbuild) inline this file at build time.
 *
 * Shape rationale: `BeadsIssueDto` mirrors `bd ready --json` / `bd list --json`
 * output (verified against `@beads/bd@1.0.5`) plus the backend-required
 * `projectKey` scoping field (design decision D7). We do NOT reshape bd's
 * field names — the mirror stores them as-is so a bd schema bump is a
 * one-file change here, not a sprawling rename across the codebase.
 */

/** bd lifecycle status. bd emits these literals in `--json`. */
export type BeadsIssueStatus = 'open' | 'in_progress' | 'blocked' | 'closed';

/**
 * Single issue as emitted by `bd ready --json` / `bd list --json`, plus the
 * backend scoping field. The counts are REQUIRED on the wire — the backend's
 * ingest DTO validates them as required ints, so the producer (`bd-adapter`'s
 * `parseIssues`) defaults any count bd omits to 0 rather than dropping the
 * field.
 */
export interface BeadsIssueDto {
  id: string;
  title: string;
  status: BeadsIssueStatus;
  /** 0 = P0 (highest). bd emits an integer; null when unset. */
  priority: number | null;
  /** bug | task | feature | message | … (free-form in bd). */
  issue_type: string;
  /** agent / session id that claimed the issue, when claimed. */
  owner: string | null;
  created_at: string;
  updated_at: string;
  dependency_count: number;
  dependent_count: number;
  comment_count: number;
  /** D7 scoping — normalized git origin (or path-hash fallback). */
  projectKey: string;
}

/** bd dependency kind. */
export type BeadsDependencyKind = 'blocks' | 'related' | 'parent-child' | 'discovered-from';

/**
 * One dependency edge. Rows carry NO per-row `projectKey` — the ingest
 * payload is per-project, so edges are scoped by the payload-level
 * `projectKey` on the backend.
 */
export interface BeadsDependencyDto {
  /** stable id — `${fromId}:${kind}:${toId}` when bd doesn't supply one. */
  id: string;
  fromId: string;
  toId: string;
  kind: BeadsDependencyKind;
}

export interface BeadsMemoryDto {
  id: string;
  body: string;
  createdAt: string;
  /** null = cross-cutting / personal (not scoped to one project). */
  projectKey: string | null;
}

/** `bd status --json` → `summary` block. */
export interface BeadsStatusSummary {
  open_issues: number;
  ready_issues: number;
  blocked_issues: number;
  in_progress_issues: number;
  closed_issues: number;
  total_issues: number;
}

/**
 * The delta (or full snapshot) the CLI POSTs to `/api/beads/ingest` whenever
 * `.beads/issues.jsonl` changes. `fullSnapshot: true` tells the backend to
 * prune issues absent from `issues` (station-wins reconciliation).
 */
export interface BeadsIngestPayload {
  sessionId: string;
  pluginId: string;
  /** D7 project key the issues/memories belong to. */
  projectKey: string;
  /** Human-readable label (repo name) for the UI. */
  projectLabel: string;
  /** When true, the backend prunes mirror rows not present in `issues`. */
  fullSnapshot?: boolean;
  issues: BeadsIssueDto[];
  /** Dependency edges between issues. The current watcher ALWAYS sends this
   *  (an empty array today — edges aren't computed in the P0 snapshot); the
   *  backend DTO nevertheless marks it optional to tolerate older producers.
   *  Field name matches the backend (`dependencies`, not `deps`). */
  dependencies: BeadsDependencyDto[];
  memories: BeadsMemoryDto[];
  summary?: BeadsStatusSummary;
}

/**
 * A mobile-originated action relayed to the CLI as a pending command
 * (`type: 'beads_action'`). The CLI replays it as a native `bd` command
 * (Task 9) then pushes the resulting state back through ingest.
 *
 * NOTE — this is the backend→CLI COMMAND hop, NOT the mobile→backend
 * request hop. The mobile client POSTs a `BeadsActionRequest`
 * (discriminator `action`, create-title in `title`) to
 * `POST /api/beads/actions`; the backend translates it in
 * `codeagent-mobile/apps/api-v2/src/beads/beads.controller.ts` (+
 * `bd-action.util.ts`) and pushes a `beads_action` command whose payload
 * the CLI decodes in `apps/cli/src/beads/wiring.ts`
 * (`beadsActionFromPayload`) into THIS shape (discriminator `kind`,
 * title/body in `text`, plus `owner`).
 */
export type BeadsActionKind = 'claim' | 'close' | 'create' | 'remember';

export interface BeadsActionCommand {
  kind: BeadsActionKind;
  /** Target issue id — required for `claim` / `close`. */
  issueId?: string;
  /** Free text — `create` title or `remember` body. */
  text?: string;
  /** `close` reason. */
  reason?: string;
  /** Owner to claim as — defaults to the session/agent id when omitted. */
  owner?: string;
  /** Project the action targets (so the right `bd` working context applies). */
  projectKey?: string;
}

/** @deprecated Renamed to `BeadsActionCommand` — the old name collided with
 *  the backend repo's mobile→backend request type (now `BeadsActionRequest`). */
export type BeadsActionPayload = BeadsActionCommand;

/** Action verb for `configureBeads` (enable / disable / status). */
export type BeadsConfigureAction = 'enable' | 'disable' | 'status';

/** Lifecycle state emitted by `configureBeads` on the per-session SSE bus. */
export type BeadsStatusState = 'enabled' | 'disabled' | 'error' | 'provisioning';

// ─── CLI → backend: provisioning lifecycle hop ───────────────────────────────
// (`POST /api/beads/provisioning`, plugin-auth.) The CLI has always PRODUCED
// these bytes but the declarations lived only in the backend repo's shared
// mirror — moved here (PR-1 of the Phase 2 single-source plan) so the
// producer types its own wire.

/**
 * Lifecycle of the CLI's Beads provisioning step (spec D10/D13).
 *
 * The CLI's composition-root provisions Beads (`bd init` → start the
 * shared dolt server → enable auto-export → start the watcher) as a
 * parallel, non-fatal concern, decoupled from the agent run. It signals
 * each phase to the backend, which fans it out as a `beads_provisioning`
 * UserEvent so the read-only mobile/web surface can show a lightweight
 * status line ("Provisioning Beads…", "Beads ready", "Beads
 * provisioning failed") — distinct from the data feed (`beads_state_changed`).
 *
 * - `provisioning` — bootstrap started / in flight.
 * - `ready`        — Beads is up; the mirror will begin receiving deltas.
 * - `failed`       — bootstrap aborted (e.g. bd install failed); the
 *                    surface explains the agent is running without Beads.
 */
export type BeadsProvisioningStatus = 'provisioning' | 'ready' | 'failed';

/**
 * Body of `POST /api/beads/provisioning` — the CLI is the producer.
 *
 * `sessionId` + `pluginId` carry the plugin-auth envelope (the CLI has
 * NO user JWT, same as `/ingest`). The backend resolves the userId from
 * the session and publishes `{ type: 'beads_provisioning', status,
 * projectKey }` on the per-user SSE bus.
 *
 * `projectKey` is optional: the home-level `bd init` runs before any
 * repo is resolved, so the first `provisioning` frame may not carry one
 * yet. `detail` is an optional human-readable note (e.g. the failure
 * reason) the surface can render verbatim.
 */
export interface BeadsProvisioningPayload {
  /** Paired session the CLI is pushing from (plugin-auth). */
  sessionId: string;
  /** Plugin id the auth token was minted for (plugin-auth). */
  pluginId: string;
  status: BeadsProvisioningStatus;
  /** Affected project, when the bootstrap has resolved a repo. */
  projectKey?: string;
  /** Optional human-readable note (e.g. failure reason). */
  detail?: string;
}

// ─── CLI → backend → app: session add-on status hop ─────────────────────────
// Produced by the CLI's `beads_configure` handler, carried on the
// `beads_status` SSE event and snapshotted by the backend into Redis.

/** Snapshot of the station's Beads add-on state (mirrored to mobile). */
export interface BeadsStatus {
  state: BeadsStatusState;
  running?: boolean;
  bdAvailable?: boolean;
  doltAvailable?: boolean;
  serverUp?: boolean;
  prefix?: string | null;
  error?: string;
}

// ─── backend → app: snapshot hop ─────────────────────────────────────────────
// (`GET /api/beads/me` + the per-user SSE `snapshot`.) The CLI never sees
// these — they're the backend's read-optimised projection for mobile/web.
// Declared here so B's beads.ts is the superset the backend repo can
// re-export from (PR-2/PR-4 delete the hand-synced mirrors + waivers).
// NOTE: on this hop the backend ENRICHES memories (projectLabel / teamId /
// readonly) beyond the producer `BeadsMemoryDto` above — those extra fields
// stay declared A-side until the re-export layer lands.

/** One project the mirror has seen — drives the project-list view. */
export interface BeadsProjectDto {
  projectKey: string;
  /** Human repo name for the UI. */
  label: string;
  /** ISO8601 — last time the CLI pushed state for this project. */
  lastSyncedAt: string;
}

/**
 * One-shot snapshot returned by `GET /api/beads/me` and embedded in the
 * per-user SSE `snapshot` so reconnects rehydrate. `issuesByProject` is
 * keyed by `projectKey`.
 */
export interface BeadsSnapshotDto {
  projects: BeadsProjectDto[];
  issuesByProject: Record<string, BeadsIssueDto[]>;
  memories: BeadsMemoryDto[];
  /** Aggregate summary across all the user's projects. */
  summary: BeadsStatusSummary;
}

// ─── app → backend: action request hop ───────────────────────────────────────
// (`POST /api/beads/actions`, JWT-authed mobile/web user.) The CLI never
// sees this shape — the backend translates it into the `BeadsActionCommand`
// relay payload above (discriminator `kind`, title/body in `text`).

/**
 * The user-initiated Beads actions a mobile/web client can request.
 *
 * - `claim`    — take ownership of a ready issue (`bd update --status in_progress`).
 * - `close`    — close an issue (`bd close`).
 * - `create`   — create a new issue (`bd create`).
 * - `remember` — record a persistent memory note (`bd remember`).
 *
 * The backend does NOT mutate the mirror directly — it relays the
 * action as a `bd` command to the user's active paired session, where
 * the CLI runs it natively against the station's `bd` graph. The
 * resulting state change flows back via `POST /api/beads/ingest` and
 * fans out over the per-user SSE bus. The mirror is read-optimised;
 * the station stays the source of truth (station-wins).
 */
export type BeadsActionType = 'claim' | 'close' | 'create' | 'remember';

/**
 * Body of `POST /api/beads/actions` (JWT-authed mobile/web user).
 *
 * NOTE — this is the mobile→backend REQUEST hop, NOT the backend→CLI
 * command hop (`BeadsActionCommand` above).
 *
 * Field relevance by action:
 * - `claim`    — `issueId` required.
 * - `close`    — `issueId` required; `reason` optional.
 * - `create`   — `title` required; `projectKey` optional (targets a project).
 * - `remember` — `text` required; `projectKey` optional (scopes the memory).
 */
export interface BeadsActionRequest {
  action: BeadsActionType;
  /** Target issue for `claim` / `close`. */
  issueId?: string;
  /** Title for a `create`d issue. */
  title?: string;
  /** Optional human-readable reason for `close`. */
  reason?: string;
  /** Memory body for `remember`. */
  text?: string;
  /** Project scope for `create` / `remember`; defaults to the station's current repo. */
  projectKey?: string;
}
