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
  /**
   * Whether this stage MUST end in a new commit to hand off. Defaults to `true`
   * (undefined = true) — a Specifier/Coder/QA produces an artifact (spec, code,
   * report) and a no-commit stage is a stall. Set `false` for review-style
   * stages that legitimately approve clean with NO change: a Reviewer that finds
   * nothing to fix should hand off "reviewed, no changes needed" against the
   * commit it reviewed, not stall the pipeline. (Agent Packs live-run finding,
   * 2026-08-08 — a clean Reviewer was mis-treated as "stage produced no commit".)
   */
  requiresCommit?: boolean;
  /**
   * Whether this stage is expected to leave a structured findings file
   * (`PACK_FINDINGS_FILE`) at the repo root, which the runner parses into
   * `PackHandoffRecord.findings` so the NEXT stage consumes an explicit list
   * instead of re-deriving it from prose. Review-style stages set this.
   */
  producesFindings?: boolean;
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

export type PackRunStatus = 'running' | 'paused' | 'stalled' | 'completed' | 'aborted' | 'failed';

export type PackStageStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped';

// ─── Structured findings (the Reviewer → QA handoff artifact) ────────────────

export type PackFindingSeverity = 'blocker' | 'major' | 'minor' | 'nit';

export type PackFindingResolution = 'fixed' | 'deferred' | 'wont_fix' | 'needs_verification';

/**
 * One review finding, machine-readable. A review-style stage writes a list of
 * these to `PACK_FINDINGS_FILE` (repo root, committed with the stage — the
 * same rail as `SPEC.pack.md`); the runner parses the file into the stage's
 * handoff so the next stage gets an explicit list to verify one by one, and
 * every finding either receives a verdict downstream or is visibly open.
 */
export interface PackFinding {
  /** Stable short id the next stage references (e.g. `R1`). */
  id: string;
  severity: PackFindingSeverity;
  /** One line: what is wrong. */
  title: string;
  /** Why it matters / what was done, a few lines at most. */
  detail?: string;
  /** Repo-relative path, when the finding points at code. */
  file?: string;
  line?: number;
  resolution: PackFindingResolution;
  /** Commit that resolves it, when `resolution === 'fixed'` (model-claimed; the
   *  stage's git-validated handoff commit is the authority). */
  commit?: string;
}

/** Repo-root file a `producesFindings` stage writes. Root, NOT `.codeam/` — the
 *  workflow article forbids agents from touching the pipeline ledger. */
export const PACK_FINDINGS_FILE = 'REVIEW-FINDINGS.pack.json';

/** Upper bound on parsed findings — a runaway list is truncated, not rejected. */
export const MAX_PACK_FINDINGS = 50;

/** Heading every stage closes its reply with; the runner lifts the section
 *  below it as the handoff summary instead of the reply's raw tail. */
export const PACK_HANDOFF_HEADING = '## Handoff';

/** Mechanically captured proof of what a stage delivered. */
export interface PackHandoffRecord {
  /** Canonical 10-hex commit abbreviation (git-validated, never model-claimed). */
  commit: string;
  /** The reply's `## Handoff` section when present, else its tail (capped). */
  summary: string;
  /** `git diff --stat` summary line between the stage's start and end commits. */
  diffStat: string;
  /** Project checks captured at the stage boundary, when a command was available. */
  checks?: { command: string; passed: boolean; tail: string };
  durationMs: number;
  /** Parsed `PACK_FINDINGS_FILE` for a `producesFindings` stage. Absent when
   *  the stage does not produce findings; empty when it audited and found none. */
  findings?: PackFinding[];
  /** Why `findings` is absent/partial on a `producesFindings` stage (no file,
   *  malformed JSON, truncated) or what an empty list checked — always honest. */
  findingsNote?: string;
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
  /**
   * The stage's turn ended with a question for the user (a select prompt the
   * app renders). The run is paused, NOT nudged — the user answers in the
   * stage chat and taps Resume, which re-checks the stage's commit gate in the
   * SAME conversation instead of starting a fresh one.
   */
  awaitingUser?: boolean;
  /** How many fresh conversations this stage has had (1 = first attempt). */
  attempts?: number;
  /** Canonical HEAD when the stage's current attempt began — the diff base for
   *  its handoff, kept stable across an in-place resume. */
  startCommit?: string;
}

/** A control the user asked for mid-turn; it takes effect at the stage boundary. */
export type PackPendingControl = 'pause' | 'abort';

export interface PackRunState {
  runId: string;
  packId: PackId;
  /** The user's task, verbatim. */
  task: string;
  status: PackRunStatus;
  /** Index into `stages` of the stage currently active/next. */
  currentStage: number;
  stages: PackStageState[];
  /** Set when status is 'stalled' | 'failed' | 'paused' with a cause — the honest reason. */
  stalledReason?: string;
  /** Canonical HEAD before the pipeline's first stage — every stage gets it so
   *  "the pipeline's diff" is `git diff <baseCommit>..HEAD`, never a guess. */
  baseCommit?: string;
  /** Set while a pause/abort requested mid-turn waits for the stage boundary;
   *  the UI shows "pausing after this stage" instead of a false PAUSED. */
  pendingControl?: PackPendingControl;
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
