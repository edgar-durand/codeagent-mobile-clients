package com.windsurf.controller.services

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.ProjectManager
import java.io.File

/**
 * Project-level helpers for the mini-IDE feature: file-tree listing,
 * git status / diff / log / branch / commit / push / pull, plus
 * conflict-resolution helpers. Git ops shell out via `ProcessBuilder`
 * (never `Runtime.exec(String)` to avoid shell injection).
 */
@Service(Service.Level.APP)
class ProjectOpsService {

    fun listFiles(query: String?): JsonObject {
        val root = projectRoot() ?: return errorObj("No open project.")
        val q = query?.trim()?.lowercase() ?: ""
        val files = JsonArray()
        var truncated = false
        var count = 0

        fun walk(dir: File, depth: Int) {
            if (count >= MAX_TREE_FILES) { truncated = true; return }
            if (depth > 12) return
            val entries = dir.listFiles() ?: return
            for (e in entries) {
                if (count >= MAX_TREE_FILES) { truncated = true; return }
                if (PROJECT_IGNORE.contains(e.name)) continue
                if (e.isDirectory) {
                    walk(e, depth + 1)
                } else if (e.isFile) {
                    val rel = e.path.removePrefix(root.path).removePrefix(File.separator)
                    if (q.isNotEmpty() && !rel.lowercase().contains(q) && !e.name.lowercase().contains(q)) continue
                    val obj = JsonObject()
                    obj.addProperty("path", rel.replace(File.separatorChar, '/'))
                    obj.addProperty("name", e.name)
                    obj.addProperty("size", e.length())
                    files.add(obj)
                    count++
                }
            }
        }

        walk(root, 0)

        val out = JsonObject()
        out.add("files", files)
        out.addProperty("truncated", truncated)
        out.addProperty("root", root.path)
        return out
    }

    fun gitStatus(): JsonObject {
        val r = git(listOf("status", "--porcelain=v2", "--branch"))
        val out = JsonObject()
        if (r.code != 0) {
            out.addProperty("branch", null as String?)
            out.add("entries", JsonArray())
            out.addProperty("ahead", 0)
            out.addProperty("behind", 0)
            out.addProperty("hasMergeInProgress", false)
            out.addProperty("error", r.stderr.trim())
            return out
        }
        var branch: String? = null
        var upstream: String? = null
        var ahead = 0
        var behind = 0
        val entries = JsonArray()
        for (raw in r.stdout.split("\n").filter { it.isNotBlank() }) {
            when {
                raw.startsWith("# branch.head ") -> branch = raw.removePrefix("# branch.head ").trim()
                raw.startsWith("# branch.upstream ") -> upstream = raw.removePrefix("# branch.upstream ").trim()
                raw.startsWith("# branch.ab ") -> {
                    val m = Regex("\\+(\\d+)\\s+-(\\d+)").find(raw)
                    if (m != null) {
                        ahead = m.groupValues[1].toInt()
                        behind = m.groupValues[2].toInt()
                    }
                }
                raw.startsWith("1 ") -> {
                    val parts = raw.split(' ')
                    val xy = parts[1]
                    val p = parts.subList(8, parts.size).joinToString(" ")
                    entries.add(entry(xy, p, null, xy[0] != '.', false))
                }
                raw.startsWith("2 ") -> {
                    val parts = raw.split(' ')
                    val xy = parts[1]
                    val tail = parts.subList(9, parts.size).joinToString(" ")
                    val (newPath, oldPath) = tail.split('\t').let {
                        Pair(it.getOrNull(0) ?: "", it.getOrNull(1))
                    }
                    entries.add(entry(xy, newPath, oldPath, xy[0] != '.', false))
                }
                raw.startsWith("? ") -> {
                    entries.add(entry("??", raw.substring(2), null, false, false))
                }
                raw.startsWith("u ") -> {
                    val parts = raw.split(' ')
                    val xy = parts[1]
                    val p = parts.subList(10, parts.size).joinToString(" ")
                    entries.add(entry(xy, p, null, false, true))
                }
            }
        }
        val mergeHead = projectRoot()?.let { File(it, ".git/MERGE_HEAD") }
        val hasMerge = mergeHead?.exists() == true
        out.addProperty("branch", branch)
        out.addProperty("upstream", upstream)
        out.addProperty("ahead", ahead)
        out.addProperty("behind", behind)
        out.add("entries", entries)
        out.addProperty("hasMergeInProgress", hasMerge)
        return out
    }

    fun gitDiff(file: String?): JsonObject = diffWith(listOf("diff", "--no-color", "--patch"), file)
    fun gitDiffStaged(file: String?): JsonObject = diffWith(listOf("diff", "--cached", "--no-color", "--patch"), file)

    private fun diffWith(base: List<String>, file: String?): JsonObject {
        val args = base.toMutableList()
        if (file != null) {
            args.add("--")
            args.add(file)
        }
        val r = git(args)
        val out = JsonObject()
        if (r.code != 0 && r.stdout.isEmpty()) {
            out.addProperty("diff", "")
            out.addProperty("truncated", false)
            out.addProperty("error", r.stderr.trim())
            return out
        }
        val truncated = r.stdout.length >= MAX_DIFF_BYTES
        val content = if (truncated) r.stdout.substring(0, MAX_DIFF_BYTES) else r.stdout
        out.addProperty("diff", content)
        out.addProperty("truncated", truncated)
        return out
    }

    fun gitLog(limit: Int): JsonObject {
        val sep = ""
        val fmt = listOf("%H", "%h", "%an", "%aI", "%s").joinToString(sep)
        val r = git(listOf("log", "-n${limit.coerceIn(1, 200)}", "--pretty=format:$fmt"))
        val out = JsonObject()
        val arr = JsonArray()
        if (r.code != 0) {
            out.add("commits", arr)
            out.addProperty("error", r.stderr.trim())
            return out
        }
        for (line in r.stdout.split("\n").filter { it.isNotBlank() }) {
            val parts = line.split(sep)
            val obj = JsonObject()
            obj.addProperty("hash", parts.getOrNull(0) ?: "")
            obj.addProperty("shortHash", parts.getOrNull(1) ?: "")
            obj.addProperty("author", parts.getOrNull(2) ?: "")
            obj.addProperty("date", parts.getOrNull(3) ?: "")
            obj.addProperty("subject", parts.getOrNull(4) ?: "")
            arr.add(obj)
        }
        out.add("commits", arr)
        return out
    }

    fun gitCommit(message: String, paths: List<String>?): JsonObject {
        if (message.isBlank()) return errorObj("Commit message is required.")
        val add = if (paths != null && paths.isNotEmpty()) {
            git(listOf("add", "--") + paths)
        } else {
            git(listOf("add", "-A"))
        }
        if (add.code != 0) return errorObj("git add failed: ${add.stderr.trim()}")
        val r = git(listOf("commit", "-m", message))
        if (r.code != 0) return errorObj(r.stderr.trim().ifEmpty { "git commit failed" })
        val head = git(listOf("rev-parse", "HEAD"))
        val out = JsonObject()
        out.addProperty("ok", true)
        out.addProperty("commit", head.stdout.trim())
        return out
    }

    fun gitPush(): JsonObject = passOrError(listOf("push"), "git push failed")
    fun gitPull(): JsonObject = passOrError(listOf("pull", "--ff-only"), "git pull failed")

    fun gitResolve(file: String, side: String): JsonObject {
        if (side != "ours" && side != "theirs") return errorObj("Invalid side")
        val r = git(listOf("checkout", "--$side", "--", file))
        if (r.code != 0) return errorObj(r.stderr.trim().ifEmpty { "git checkout --$side failed" })
        val add = git(listOf("add", "--", file))
        if (add.code != 0) return errorObj(add.stderr.trim().ifEmpty { "git add (resolve) failed" })
        val out = JsonObject()
        out.addProperty("ok", true)
        return out
    }

    private fun passOrError(args: List<String>, fallback: String): JsonObject {
        val r = git(args)
        val out = JsonObject()
        if (r.code != 0) {
            out.addProperty("error", r.stderr.trim().ifEmpty { fallback })
            return out
        }
        out.addProperty("ok", true)
        out.addProperty("output", (r.stdout + r.stderr).trim())
        return out
    }

    private data class GitResult(val stdout: String, val stderr: String, val code: Int)

    private fun git(args: List<String>): GitResult {
        val root = projectRoot() ?: return GitResult("", "No open project", 1)
        return try {
            val pb = ProcessBuilder(listOf("git") + args).directory(root).redirectErrorStream(false)
            val proc = pb.start()
            val stdout = proc.inputStream.bufferedReader().readText().take(MAX_GIT_OUTPUT)
            val stderr = proc.errorStream.bufferedReader().readText().take(MAX_GIT_OUTPUT)
            val finished = proc.waitFor(30, java.util.concurrent.TimeUnit.SECONDS)
            if (!finished) {
                proc.destroyForcibly()
                GitResult(stdout, "git timed out", 124)
            } else {
                GitResult(stdout, stderr, proc.exitValue())
            }
        } catch (e: Exception) {
            GitResult("", e.message ?: "git failed", 1)
        }
    }

    private fun projectRoot(): File? {
        val proj = ProjectManager.getInstance().openProjects.firstOrNull() ?: return null
        return proj.basePath?.let { File(it).canonicalFile }
    }

    private fun entry(code: String, path: String, oldPath: String?, staged: Boolean, conflict: Boolean): JsonObject {
        val o = JsonObject()
        o.addProperty("code", code)
        o.addProperty("path", path)
        if (oldPath != null) o.addProperty("oldPath", oldPath)
        o.addProperty("staged", staged)
        o.addProperty("conflict", conflict)
        return o
    }

    private fun errorObj(message: String): JsonObject {
        val obj = JsonObject()
        obj.addProperty("error", message)
        return obj
    }

    companion object {
        private const val MAX_TREE_FILES = 5000
        private const val MAX_DIFF_BYTES = 512 * 1024
        private const val MAX_GIT_OUTPUT = 256 * 1024

        private val PROJECT_IGNORE = setOf(
            "node_modules", ".git", ".next", ".expo", "dist", "build", "out", ".cache",
            "coverage", ".turbo", ".parcel-cache", ".idea", ".vscode", ".vscode-test",
            "ios", "android", ".gradle", ".cxx", ".intellijPlatform", ".kotlin",
            "tmp", "target", "venv", ".venv", ".mypy_cache", ".pytest_cache",
            "__pycache__", ".DS_Store",
        )

        fun getInstance(): ProjectOpsService =
            ApplicationManager.getApplication().getService(ProjectOpsService::class.java)
    }
}
