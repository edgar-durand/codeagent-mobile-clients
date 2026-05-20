package com.windsurf.controller.services.filewatcher

// NOTE on doc comments: Kotlin block comments NEST, so an inner '/' + '*'
// would re-open a comment. We use single-line '//' doc comments
// everywhere below to avoid the "Missing '}' / Unclosed comment past EOF"
// trap documented in project memory.

// File-change status as emitted to the backend's /api/files/changed +
// /api/review/hunks endpoints. Mirrors the TS FileChangeStatus union in
// @codeagent/shared.
enum class FileChangeStatus(val wire: String) {
    MODIFIED("modified"),
    ADDED("added"),
    DELETED("deleted"),
    RENAMED("renamed");
}

// Review status sent on the FileChangedEvent. Only "awaiting_review" is
// emitted by this producer; the rest are server-side states.
enum class FileReviewStatus(val wire: String) {
    AWAITING_REVIEW("awaiting_review"),
}

// One line inside a parsed hunk. Matches PendingReviewHunkLine in the
// shared TS types - same field names so JSON serialisation is identical.
data class HunkLine(
    val type: HunkLineType,
    val lineNumber: Int,
    val text: String,
)

enum class HunkLineType(val wire: String) {
    ADD("add"),
    REMOVE("remove"),
    CONTEXT("context"),
}

// One parsed hunk, ready to be POSTed to /api/review/hunks (after the
// caller tacks on sessionId / pluginId / filePath / fileStatus).
data class ParsedHunk(
    val header: String,
    val lines: List<HunkLine>,
    val linesAdded: Int,
    val linesRemoved: Int,
)

data class ParsedDiff(
    val fileStatus: FileChangeStatus,
    val hunks: List<ParsedHunk>,
    val totalLinesAdded: Int,
    val totalLinesRemoved: Int,
)

// Kotlin port of apps/cli/src/services/file-watcher/diff-parser.ts.
//
// Tolerant on purpose:
//   - empty input  -> { fileStatus: MODIFIED, hunks: [], 0, 0 }
//   - missing 'diff --git' preamble (git --no-index against /dev/null
//     skips it) still produces hunks
//   - '\ No newline at end of file' marker lines are skipped
//   - binary diffs ('Binary files ... differ') produce zero hunks but
//     keep the derived fileStatus
//
// Line numbers on add / context entries carry the post-change ('+'
// gutter) numbers - what the mobile UI renders directly. Remove entries
// carry the pre-change ('-') number so the user can still see which line
// was deleted in the original file.
object DiffParser {

    private val HUNK_HEADER_RE = Regex("""^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@""")

    fun parseUnifiedDiff(diff: String): ParsedDiff {
        if (diff.isBlank()) {
            return ParsedDiff(
                fileStatus = FileChangeStatus.MODIFIED,
                hunks = emptyList(),
                totalLinesAdded = 0,
                totalLinesRemoved = 0,
            )
        }

        val rawLines = diff.split(Regex("\\r?\\n"))
        val fileStatus = detectFileStatus(rawLines)

        val hunks = mutableListOf<ParsedHunk>()
        var currentHeader: String? = null
        val currentLines = mutableListOf<HunkLine>()
        var currentAdded = 0
        var currentRemoved = 0
        var oldLine = 0
        var newLine = 0
        var totalAdded = 0
        var totalRemoved = 0

        fun flushCurrent() {
            val header = currentHeader ?: return
            hunks.add(
                ParsedHunk(
                    header = header,
                    lines = currentLines.toList(),
                    linesAdded = currentAdded,
                    linesRemoved = currentRemoved,
                ),
            )
            currentLines.clear()
            currentAdded = 0
            currentRemoved = 0
            currentHeader = null
        }

        for (raw in rawLines) {
            if (raw.startsWith("@@")) {
                val match = HUNK_HEADER_RE.find(raw)
                if (match == null) continue
                flushCurrent()
                oldLine = match.groupValues[1].toInt()
                newLine = match.groupValues[2].toInt()
                currentHeader = raw
                continue
            }
            if (currentHeader == null) continue

            // git diff emits this marker after a context/add/remove block
            // when the file has no trailing newline. Metadata, not
            // content - skip.
            if (raw.startsWith("\\ No newline")) continue

            when {
                raw.startsWith("+") -> {
                    currentLines.add(
                        HunkLine(
                            type = HunkLineType.ADD,
                            lineNumber = newLine,
                            text = raw.substring(1),
                        ),
                    )
                    currentAdded += 1
                    totalAdded += 1
                    newLine += 1
                }
                raw.startsWith("-") -> {
                    currentLines.add(
                        HunkLine(
                            type = HunkLineType.REMOVE,
                            lineNumber = oldLine,
                            text = raw.substring(1),
                        ),
                    )
                    currentRemoved += 1
                    totalRemoved += 1
                    oldLine += 1
                }
                raw.startsWith(" ") -> {
                    currentLines.add(
                        HunkLine(
                            type = HunkLineType.CONTEXT,
                            lineNumber = newLine,
                            text = raw.substring(1),
                        ),
                    )
                    newLine += 1
                    oldLine += 1
                }
                // Anything else (diff --git, index, +++, ---) sits in the
                // preamble and was already accounted for in
                // detectFileStatus - skip.
            }
        }
        flushCurrent()

        return ParsedDiff(
            fileStatus = fileStatus,
            hunks = hunks.toList(),
            totalLinesAdded = totalAdded,
            totalLinesRemoved = totalRemoved,
        )
    }

    private fun detectFileStatus(rawLines: List<String>): FileChangeStatus {
        // Look at the diff preamble (everything before the first hunk).
        // Git emits one of:
        //   'new file mode <oct>'        -> added
        //   'deleted file mode <oct>'    -> deleted
        //   'rename from ... rename to'  -> renamed
        // before the '--- /dev/null' / '+++ b/<path>' pair. None of
        // those appearing means an in-place modification.
        for (line in rawLines) {
            if (line.startsWith("@@")) break
            if (line.startsWith("new file mode")) return FileChangeStatus.ADDED
            if (line.startsWith("deleted file mode")) return FileChangeStatus.DELETED
            if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
                return FileChangeStatus.RENAMED
            }
            // 'git diff --no-index /dev/null <path>' does not print
            // 'new file mode' but does set the source to /dev/null;
            // that is the path we take for untracked files.
            if (line.startsWith("--- /dev/null")) return FileChangeStatus.ADDED
            if (line.startsWith("+++ /dev/null")) return FileChangeStatus.DELETED
        }
        return FileChangeStatus.MODIFIED
    }
}
