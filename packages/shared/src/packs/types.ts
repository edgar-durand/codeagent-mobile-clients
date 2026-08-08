//
// Agent Packs — curated multi-role pipelines run on ONE workspace, one stage at
// a time, each stage in a FRESH agent conversation (role isolation is about
// context, not filesystem). The registry model mirrors Agent Skills: content is
// bundled in this package and selected by id — no secrets, no fetch.
//
// Spec: codeagent-mobile/docs/superpowers/specs/2026-08-08-agent-packs-design.md.

/** Curated packs shipped with the client. Grows over time. */
export type PackId = 'quick-pack' | 'full-pack';

/** A role inside a pack — one pipeline stage. */
export interface PackStageDef {
  /** Stable role key (also the commit byline: `By <role>.`). */
  role: string;
  /** Display name for the pipeline UI. */
  name: string;
  /** One line: what this specialist does — shown on the pack card. */
  description: string;
  /** Curated skills mounted for this stage (skillFile rail, best-effort). */
  skillIds: string[];
  /** The full role prompt sent (with the pack workflow article + task +
   *  previous handoff) as the stage's opening prompt. Read-only in the app. */
  prompt: string;
}

export interface PackDefinition {
  id: PackId;
  name: string;
  /** One line for the pack card. */
  tagline: string;
  /** Plan gate — 'free' or 'pro' (enforced backend-side on pack_start). */
  gate: 'free' | 'pro';
  stages: PackStageDef[];
}

// ─── Run state (the wire + durable-ledger shape) ─────────────────────────────

export type PackRunStatus =
  | 'running'
  | 'paused'
  | 'stalled'
  | 'completed'
  | 'aborted'
  | 'failed';

export type PackStageStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped';

/** Mechanically captured proof of what a stage delivered. */
export interface PackHandoffRecord {
  /** Canonical 10-hex commit abbreviation (git-validated, never model-claimed). */
  commit: string;
  /** Short summary of the stage's reply (first lines, capped). */
  summary: string;
  /** `git diff --stat` summary line between the stage's start and end commits. */
  diffStat: string;
  /** Project checks captured at the stage boundary, when a command was available. */
  checks?: { command: string; passed: boolean; tail: string };
  durationMs: number;
}

export interface PackStageState {
  role: string;
  name: string;
  status: PackStageStatus;
  /** ACP conversation id for this stage — mobile deep-links the stage chat. */
  conversationId?: string;
  handoff?: PackHandoffRecord;
  /** Populated when status === 'failed' (or the run stalled on this stage). */
  error?: string;
}

export interface PackRunState {
  runId: string;
  packId: PackId;
  /** The user's task, verbatim. */
  task: string;
  status: PackRunStatus;
  /** Index into `stages` of the stage currently active/next. */
  currentStage: number;
  stages: PackStageState[];
  /** Set when status is 'stalled' | 'failed' — the honest reason. */
  stalledReason?: string;
  startedAt: string;
  updatedAt: string;
}

// ─── Wire commands (relay) + events ──────────────────────────────────────────

/** Relay command: start a pack run on the session. */
export interface PackStartPayload {
  packId: PackId;
  task: string;
}

export type PackActionKind = 'pause' | 'resume' | 'retry_stage' | 'skip_stage' | 'abort';

/** Relay command: mutate the active run. */
export interface PackActionPayload {
  action: PackActionKind;
}

export const PACK_START_COMMAND = 'pack_start';
export const PACK_ACTION_COMMAND = 'pack_action';
export const PACK_STATUS_COMMAND = 'pack_status';
