package com.windsurf.controller.services.filewatcher

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DiffParserTest {

    @Test
    fun `returns zeros on empty input`() {
        val r = DiffParser.parseUnifiedDiff("")
        assertEquals(emptyList(), r.hunks)
        assertEquals(0, r.totalLinesAdded)
        assertEquals(0, r.totalLinesRemoved)
        assertEquals(FileChangeStatus.MODIFIED, r.fileStatus)
    }

    @Test
    fun `returns zeros on whitespace-only input`() {
        val r = DiffParser.parseUnifiedDiff("   \n\n")
        assertEquals(emptyList(), r.hunks)
        assertEquals(0, r.totalLinesAdded)
        assertEquals(0, r.totalLinesRemoved)
        assertEquals(FileChangeStatus.MODIFIED, r.fileStatus)
    }

    @Test
    fun `parses a modified file with one hunk`() {
        val diff = listOf(
            "diff --git a/foo.ts b/foo.ts",
            "index abc..def 100644",
            "--- a/foo.ts",
            "+++ b/foo.ts",
            "@@ -1,3 +1,4 @@",
            " const a = 1;",
            "-const b = 2;",
            "+const b = 3;",
            "+const c = 4;",
            " const d = 5;",
        ).joinToString("\n")

        val r = DiffParser.parseUnifiedDiff(diff)
        assertEquals(FileChangeStatus.MODIFIED, r.fileStatus)
        assertEquals(1, r.hunks.size)
        assertEquals(2, r.totalLinesAdded)
        assertEquals(1, r.totalLinesRemoved)
        assertEquals("@@ -1,3 +1,4 @@", r.hunks[0].header)
        assertEquals(
            listOf(
                HunkLineType.CONTEXT,
                HunkLineType.REMOVE,
                HunkLineType.ADD,
                HunkLineType.ADD,
                HunkLineType.CONTEXT,
            ),
            r.hunks[0].lines.map { it.type },
        )
        // Post-change gutter line numbers:
        //   context line 1 -> 1
        //   removed line 2 -> carries OLD line number 2
        //   added line 2   -> new line 2
        //   added line 3   -> new line 3
        //   context line 4 -> 4
        assertEquals(
            listOf(1, 2, 2, 3, 4),
            r.hunks[0].lines.map { it.lineNumber },
        )
        // Per-hunk counts should equal the totals when there's one hunk.
        assertEquals(2, r.hunks[0].linesAdded)
        assertEquals(1, r.hunks[0].linesRemoved)
        // Text strips the leading +/-/space sigil.
        assertEquals("const a = 1;", r.hunks[0].lines[0].text)
        assertEquals("const b = 2;", r.hunks[0].lines[1].text)
        assertEquals("const b = 3;", r.hunks[0].lines[2].text)
    }

    @Test
    fun `detects new file mode as added`() {
        val diff = listOf(
            "diff --git a/new.ts b/new.ts",
            "new file mode 100644",
            "index 0000..abc",
            "--- /dev/null",
            "+++ b/new.ts",
            "@@ -0,0 +1,2 @@",
            "+line one",
            "+line two",
        ).joinToString("\n")
        val r = DiffParser.parseUnifiedDiff(diff)
        assertEquals(FileChangeStatus.ADDED, r.fileStatus)
        assertEquals(1, r.hunks.size)
        assertEquals(2, r.totalLinesAdded)
        assertEquals(0, r.totalLinesRemoved)
    }

    @Test
    fun `detects deleted file mode as deleted`() {
        val diff = listOf(
            "diff --git a/gone.ts b/gone.ts",
            "deleted file mode 100644",
            "--- a/gone.ts",
            "+++ /dev/null",
            "@@ -1,2 +0,0 @@",
            "-line one",
            "-line two",
        ).joinToString("\n")
        val r = DiffParser.parseUnifiedDiff(diff)
        assertEquals(FileChangeStatus.DELETED, r.fileStatus)
        assertEquals(0, r.totalLinesAdded)
        assertEquals(2, r.totalLinesRemoved)
    }

    @Test
    fun `detects rename as renamed`() {
        val diff = listOf(
            "diff --git a/old.ts b/new.ts",
            "similarity index 100%",
            "rename from old.ts",
            "rename to new.ts",
        ).joinToString("\n")
        assertEquals(
            FileChangeStatus.RENAMED,
            DiffParser.parseUnifiedDiff(diff).fileStatus,
        )
    }

    @Test
    fun `detects --no-index against dev null as added`() {
        // 'git diff --no-color --no-index /dev/null <path>' produces this
        // shape for untracked files - no 'new file mode' marker, only
        // the /dev/null source.
        val diff = listOf(
            "diff --git a/dev/null b/foo.ts",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/foo.ts",
            "@@ -0,0 +1,1 @@",
            "+only line",
        ).joinToString("\n")
        assertEquals(
            FileChangeStatus.ADDED,
            DiffParser.parseUnifiedDiff(diff).fileStatus,
        )
    }

    @Test
    fun `ignores no-newline-at-end-of-file markers`() {
        val diff = listOf(
            "--- a/foo.ts",
            "+++ b/foo.ts",
            "@@ -1,1 +1,1 @@",
            "-old",
            "\\ No newline at end of file",
            "+new",
            "\\ No newline at end of file",
        ).joinToString("\n")
        val r = DiffParser.parseUnifiedDiff(diff)
        assertEquals(1, r.totalLinesAdded)
        assertEquals(1, r.totalLinesRemoved)
        assertEquals(2, r.hunks[0].lines.size)
    }

    @Test
    fun `parses multiple hunks in one diff`() {
        val diff = listOf(
            "--- a/foo.ts",
            "+++ b/foo.ts",
            "@@ -1,2 +1,2 @@",
            "-old1",
            "+new1",
            " ctx",
            "@@ -10,2 +10,2 @@",
            "-old2",
            "+new2",
            " ctx2",
        ).joinToString("\n")
        val r = DiffParser.parseUnifiedDiff(diff)
        assertEquals(2, r.hunks.size)
        assertEquals(2, r.totalLinesAdded)
        assertEquals(2, r.totalLinesRemoved)
        assertEquals("@@ -1,2 +1,2 @@", r.hunks[0].header)
        assertEquals("@@ -10,2 +10,2 @@", r.hunks[1].header)
        // Second hunk gutter line numbers start at 10 (not 4 - we
        // honour the @@ header, we don't continue counting).
        assertEquals(10, r.hunks[1].lines[0].lineNumber)
    }

    @Test
    fun `handles CRLF line endings`() {
        val diff = listOf(
            "diff --git a/foo.ts b/foo.ts",
            "--- a/foo.ts",
            "+++ b/foo.ts",
            "@@ -1,1 +1,2 @@",
            " a",
            "+b",
        ).joinToString("\r\n")
        val r = DiffParser.parseUnifiedDiff(diff)
        assertEquals(1, r.hunks.size)
        assertEquals(1, r.totalLinesAdded)
    }

    @Test
    fun `binary diffs produce zero hunks but keep added status`() {
        val diff = listOf(
            "diff --git a/img.png b/img.png",
            "new file mode 100644",
            "Binary files /dev/null and b/img.png differ",
        ).joinToString("\n")
        val r = DiffParser.parseUnifiedDiff(diff)
        assertEquals(FileChangeStatus.ADDED, r.fileStatus)
        assertEquals(0, r.hunks.size)
    }

    @Test
    fun `malformed hunk header is skipped without crashing`() {
        val diff = listOf(
            "--- a/foo.ts",
            "+++ b/foo.ts",
            "@@ not a real header @@",
            "+stuff",
        ).joinToString("\n")
        val r = DiffParser.parseUnifiedDiff(diff)
        // The malformed header was rejected; subsequent body lines have
        // no enclosing hunk so they are silently dropped.
        assertEquals(0, r.hunks.size)
        assertEquals(0, r.totalLinesAdded)
    }

    @Test
    fun `context lines do not count as add or remove`() {
        val diff = listOf(
            "@@ -1,3 +1,3 @@",
            " a",
            " b",
            " c",
        ).joinToString("\n")
        val r = DiffParser.parseUnifiedDiff(diff)
        assertEquals(0, r.totalLinesAdded)
        assertEquals(0, r.totalLinesRemoved)
        assertEquals(3, r.hunks[0].lines.size)
        assertTrue(r.hunks[0].lines.all { it.type == HunkLineType.CONTEXT })
        assertEquals(listOf(1, 2, 3), r.hunks[0].lines.map { it.lineNumber })
    }

    @Test
    fun `hunk header without count uses default of 1`() {
        // git emits '@@ -5 +5 @@' (no comma) when a hunk covers exactly
        // one line. The regex must accept that shorthand.
        val diff = listOf(
            "@@ -5 +5 @@",
            "-old",
            "+new",
        ).joinToString("\n")
        val r = DiffParser.parseUnifiedDiff(diff)
        assertEquals(1, r.hunks.size)
        assertEquals("@@ -5 +5 @@", r.hunks[0].header)
        assertEquals(5, r.hunks[0].lines[0].lineNumber)
        assertEquals(5, r.hunks[0].lines[1].lineNumber)
    }
}
