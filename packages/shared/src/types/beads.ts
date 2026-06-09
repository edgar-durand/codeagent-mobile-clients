/**
 * Beads wire protocol — the bytes the codeam-cli pushes to the backend's
 * `POST /api/beads/ingest` and that the backend mirrors + fans out over the
 * per-user SSE bus. These types MUST match the backend's `BeadsIngestPayload`
 * byte-for-byte (the backend contract is already live behind the `beads`
 * feature flag). Keep this file the single source of truth for the shape;
 * both the CLI (bundled via tsup) and the VS Code extension (esbuild) inline
 * it at build time.
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
 * backend scoping field. Optional counts are present on `list`/`ready` output
 * but we keep them optional so a future bd version that drops one doesn't
 * fail validation.
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
  dependency_count?: number;
  dependent_count?: number;
  comment_count?: number;
  /** D7 scoping — normalized git origin (or path-hash fallback). */
  projectKey: string;
}

/** bd dependency kind. */
export type BeadsDependencyKind = 'blocks' | 'related' | 'parent-child' | 'discovered-from';

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
  deps?: BeadsDependencyDto[];
  memories: BeadsMemoryDto[];
  summary?: BeadsStatusSummary;
}

/**
 * A mobile-originated action relayed to the CLI as a pending command
 * (`type: 'beads_action'`). The CLI replays it as a native `bd` command
 * (Task 9) then pushes the resulting state back through ingest.
 */
export type BeadsActionKind = 'claim' | 'close' | 'create' | 'remember';

export interface BeadsActionPayload {
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
