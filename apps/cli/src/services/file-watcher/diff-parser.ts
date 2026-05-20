import type {
  FileChangeStatus,
  PendingReviewHunkLine,
} from '@codeagent/shared';

/**
 * One parsed unified-diff hunk. Mirrors the shape the backend's
 * `/api/review/hunks` endpoint accepts, minus the wire fields
 * (`sessionId`, `pluginId`, `filePath`, `fileStatus`) that are
 * tacked on by the caller.
 */
export interface ParsedHunk {
  header: string;
  lines: PendingReviewHunkLine[];
  linesAdded: number;
  linesRemoved: number;
}

export interface ParsedDiff {
  /**
   * The status of the file as derived from the `diff --git` header
   * (`new file mode`, `deleted file mode`, `rename from/to`) — or
   * `'modified'` when none of those markers are present.
   */
  fileStatus: FileChangeStatus;
  hunks: ParsedHunk[];
  totalLinesAdded: number;
  totalLinesRemoved: number;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parse a unified diff (the output of `git diff --no-color -- <path>`
 * or `git diff --no-color --no-index ...`) into a structured form
 * suitable for emission to the backend.
 *
 * Tolerant on purpose:
 *   - empty input → `{ fileStatus: 'modified', hunks: [], 0, 0 }`
 *   - missing headers (some git versions emit just `@@ ... @@` lines
 *     for `--no-index` against /dev/null) still produce hunks
 *   - "\ No newline at end of file" lines are skipped
 *   - binary diffs (`Binary files ... differ`) produce zero hunks but
 *     keep the derived `fileStatus`
 *
 * The line numbers on add / context entries are the post-change ('+')
 * gutter numbers (what shows up in the mobile UI). Remove entries
 * carry the pre-change ('-') number so the user can see which line
 * was deleted in the original.
 */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  if (!diff || diff.trim().length === 0) {
    return {
      fileStatus: 'modified',
      hunks: [],
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
    };
  }

  const rawLines = diff.split(/\r?\n/);
  const fileStatus = detectFileStatus(rawLines);

  const hunks: ParsedHunk[] = [];
  let current: ParsedHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let totalAdded = 0;
  let totalRemoved = 0;

  for (const raw of rawLines) {
    if (raw.startsWith('@@')) {
      const match = raw.match(HUNK_HEADER_RE);
      if (!match) continue;
      if (current) hunks.push(current);
      oldLine = parseInt(match[1], 10);
      newLine = parseInt(match[2], 10);
      current = {
        header: raw,
        lines: [],
        linesAdded: 0,
        linesRemoved: 0,
      };
      continue;
    }
    if (current === null) continue;

    // `git diff` emits a marker line after a context/add/remove block
    // when the file has no trailing newline. Skip — it's metadata,
    // not content.
    if (raw.startsWith('\\ No newline')) continue;

    if (raw.startsWith('+')) {
      current.lines.push({ type: 'add', lineNumber: newLine, text: raw.slice(1) });
      current.linesAdded += 1;
      totalAdded += 1;
      newLine += 1;
      continue;
    }
    if (raw.startsWith('-')) {
      current.lines.push({ type: 'remove', lineNumber: oldLine, text: raw.slice(1) });
      current.linesRemoved += 1;
      totalRemoved += 1;
      oldLine += 1;
      continue;
    }
    if (raw.startsWith(' ')) {
      current.lines.push({ type: 'context', lineNumber: newLine, text: raw.slice(1) });
      newLine += 1;
      oldLine += 1;
      continue;
    }
    // Anything else (e.g. `diff --git`, `index`, `+++`, `---`)
    // surfaces between hunk bodies in the streamed output — we've
    // already extracted `fileStatus` above, so just keep going.
  }
  if (current) hunks.push(current);

  return {
    fileStatus,
    hunks,
    totalLinesAdded: totalAdded,
    totalLinesRemoved: totalRemoved,
  };
}

function detectFileStatus(rawLines: string[]): FileChangeStatus {
  // Look at the diff preamble (everything before the first hunk).
  // Git emits one of:
  //   `new file mode <oct>`        → added
  //   `deleted file mode <oct>`    → deleted
  //   `rename from ... rename to`  → renamed
  // before the `--- /dev/null` / `+++ b/<path>` pair. None of those
  // appearing means an in-place modification.
  for (const line of rawLines) {
    if (line.startsWith('@@')) break;
    if (line.startsWith('new file mode')) return 'added';
    if (line.startsWith('deleted file mode')) return 'deleted';
    if (line.startsWith('rename from ') || line.startsWith('rename to ')) {
      return 'renamed';
    }
    // `git diff --no-index /dev/null <path>` doesn't print
    // `new file mode` but does set the source to /dev/null. That's
    // the path we take for untracked files.
    if (line.startsWith('--- /dev/null')) return 'added';
    if (line.startsWith('+++ /dev/null')) return 'deleted';
  }
  return 'modified';
}
