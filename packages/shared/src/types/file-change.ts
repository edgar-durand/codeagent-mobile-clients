/**
 * Wire-shape types for the CLI / IDE-plugin → backend producer endpoints
 * that feed the mobile Files screen and the Pending Review Queue:
 *
 *   - `POST /api/files/changed`  — register a file change (upsert keyed by
 *     `sessionId + filePath` server-side, so re-emitting on every save is
 *     safe).
 *   - `POST /api/review/hunks`   — register an individual hunk for the
 *     Pending Review Queue. The "Aggressive" policy this codebase ships
 *     with sends one of these per hunk in the diff so the mobile user
 *     approves/rejects each one independently.
 *
 * These mirror the backend NestJS DTOs at:
 *   apps/api-v2/src/files/dto/report-file-changed.dto.ts
 *   apps/api-v2/src/review/dto/create-hunk.dto.ts
 *
 * They are wire-only — no class-validator decorators, no runtime
 * coercion. The producer constructs them in TypeScript and serialises
 * directly to JSON. The backend re-validates on its side.
 */

export type FileChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed';

export type FileReviewStatus =
  | 'modified'
  | 'awaiting_review'
  | 'approved'
  | 'rejected'
  | 'reviewed';

/**
 * Body for `POST /api/files/changed`. The producer emits one of these
 * per modified file per session-tick (debounced). The server upserts
 * on `(sessionId, filePath)` so re-emitting on every save is safe.
 *
 * `pluginId` is required by the backend's `PluginAuthGuard` — it's
 * read off the body so the guard can derive the expected HMAC of the
 * `X-Plugin-Auth-Token` header against this exact `(session, plugin)`
 * pair before the controller runs.
 */
export interface FileChangedEvent {
  sessionId: string;
  pluginId: string;
  filePath: string;
  fileStatus: FileChangeStatus;
  linesAdded: number;
  linesRemoved: number;
  hunkCount: number;
  /**
   * Optional. When the producer also emits hunks to `/api/review/hunks`
   * for this file, set this to `'awaiting_review'` so the Files screen
   * renders the pending-review badge. Defaults to `'modified'`
   * server-side when omitted.
   */
  reviewStatus?: FileReviewStatus;
}

export type HunkLineType = 'add' | 'remove' | 'context';

/**
 * One line of a unified diff hunk. `lineNumber` carries the
 * post-change ('+'-side) line numbers from `git diff` so the mobile
 * UI can render the gutter without re-deriving them.
 */
export interface PendingReviewHunkLine {
  type: HunkLineType;
  lineNumber: number;
  text: string;
}

/**
 * Body for `POST /api/review/hunks`. One per hunk in the diff.
 *
 * `reasoning` and `sessionLogPreview` are nullable — the v1 chokidar
 * producer doesn't have either (it can't tell agent edits from human
 * edits, and it doesn't read the agent's rationale), so it skips
 * these fields entirely. A future PTY-output-parsing producer can
 * populate them.
 */
export interface PendingReviewHunkEvent {
  sessionId: string;
  pluginId: string;
  filePath: string;
  fileStatus: FileChangeStatus;
  hunkHeader: string;
  lines: PendingReviewHunkLine[];
  linesAdded: number;
  linesRemoved: number;
  reasoning?: string;
  sessionLogPreview?: string[];
}
