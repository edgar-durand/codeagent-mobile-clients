/**
 * Beads wire protocol — the bytes the codeam-cli pushes to the backend's
 * `POST /api/beads/ingest` and that the backend mirrors + fans out over the
 * per-user SSE bus.
 *
 * CANONICAL WIRE OWNER: this file (`@codeagent/shared`) owns the wire
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
