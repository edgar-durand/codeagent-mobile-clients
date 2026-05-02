package com.windsurf.controller.services

import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtil
import java.io.File
import java.nio.charset.StandardCharsets

/**
 * File read/write helpers for the mobile / landing mini-IDE modal.
 *
 * Resolves paths against the open IntelliJ project. Tries the direct
 * project-relative path first, then walks the project tree (capped at
 * depth 6, ignoring noise dirs) and matches by suffix so an agent that
 * emits a path relative to a deeper subdirectory still resolves cleanly
 * to the right file.
 *
 * Writes go through `LocalFileSystem` + `VfsUtil.saveText` inside a
 * `runWriteAction` so the IDE picks up the change immediately (editor
 * refreshes, indexers re-run) — same effect as the user typing in IntelliJ.
 */
@Service(Service.Level.APP)
class FileOpsService {

    fun readFile(rawPath: String): JsonObject {
        return try {
            val file = resolve(rawPath) ?: return errorObj("File not found in the project tree: $rawPath")
            if (!file.isFile) return errorObj("Not a regular file.")
            if (file.length() > MAX_BYTES) {
                return errorObj("File too large (${file.length() / 1024 / 1024} MB).")
            }
            val bytes = file.readBytes()
            if (looksBinary(bytes)) return errorObj("Binary file — refusing to open in a code editor.")
            val obj = JsonObject()
            obj.addProperty("content", String(bytes, StandardCharsets.UTF_8))
            obj
        } catch (e: Exception) {
            errorObj(e.message ?: "Read failed")
        }
    }

    fun writeFile(rawPath: String, content: String): JsonObject {
        return try {
            val file = resolve(rawPath) ?: directWriteTarget(rawPath)
                ?: return errorObj("Path escapes the open project.")
            val bytes = content.toByteArray(StandardCharsets.UTF_8)
            if (bytes.size > MAX_BYTES) return errorObj("Content too large.")

            file.parentFile?.let { parent ->
                if (!parent.exists()) parent.mkdirs()
            }

            ApplicationManager.getApplication().invokeAndWait {
                ApplicationManager.getApplication().runWriteAction {
                    val vfile = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(file)
                    if (vfile != null) {
                        VfsUtil.saveText(vfile, content)
                    } else {
                        file.writeBytes(bytes)
                        LocalFileSystem.getInstance().refreshAndFindFileByIoFile(file)
                    }
                }
            }

            val obj = JsonObject()
            obj.addProperty("ok", true)
            obj
        } catch (e: Exception) {
            errorObj(e.message ?: "Write failed")
        }
    }

    /**
     * Pass 1: every open project's basePath + direct relative resolution.
     * Pass 2: recursive suffix-match walk. Returns the shortest match.
     */
    private fun resolve(rawPath: String): File? {
        val roots = ProjectManager.getInstance().openProjects.mapNotNull { proj ->
            proj.basePath?.let { File(it).canonicalFile }
        }
        if (roots.isEmpty()) return null

        // Pass 1
        for (root in roots) {
            val candidate = if (File(rawPath).isAbsolute) {
                File(rawPath).canonicalFile
            } else {
                File(root, rawPath).canonicalFile
            }
            if (isUnder(root, candidate) && candidate.isFile) return candidate
        }

        // Pass 2
        val needle = "/" + rawPath.trimStart('.', '/', '\\').replace('\\', '/')
        val matches = mutableListOf<File>()
        val ctx = WalkContext(visited = 0, cap = 16, matches = matches)
        for (root in roots) {
            walk(root, needle, depth = 0, ctx = ctx)
            if (matches.size >= ctx.cap) break
        }
        return matches
            .filter { f -> roots.any { isUnder(it, f) } }
            .minByOrNull { it.path.length }
    }

    private fun directWriteTarget(rawPath: String): File? {
        val roots = ProjectManager.getInstance().openProjects.mapNotNull { proj ->
            proj.basePath?.let { File(it).canonicalFile }
        }
        for (root in roots) {
            val candidate = if (File(rawPath).isAbsolute) {
                File(rawPath).canonicalFile
            } else {
                File(root, rawPath).canonicalFile
            }
            if (isUnder(root, candidate)) return candidate
        }
        return null
    }

    private data class WalkContext(var visited: Int, val cap: Int, val matches: MutableList<File>)

    private fun walk(dir: File, needle: String, depth: Int, ctx: WalkContext) {
        if (depth > MAX_WALK_DEPTH) return
        if (ctx.visited > MAX_VISITED_DIRS) return
        if (ctx.matches.size >= ctx.cap) return
        ctx.visited++

        val entries = dir.listFiles() ?: return

        // Files first.
        for (e in entries) {
            if (e.isFile) {
                val p = e.path.replace('\\', '/')
                if (p.endsWith(needle)) {
                    ctx.matches.add(e)
                    if (ctx.matches.size >= ctx.cap) return
                }
            }
        }
        // Then dirs.
        for (e in entries) {
            if (!e.isDirectory) continue
            if (SUBDIR_IGNORE.contains(e.name)) continue
            walk(e, needle, depth + 1, ctx)
            if (ctx.matches.size >= ctx.cap) return
        }
    }

    private fun isUnder(parent: File, candidate: File): Boolean {
        val p = parent.path
        val c = candidate.path
        if (c == p) return true
        return c.startsWith(p + File.separator)
    }

    private fun looksBinary(bytes: ByteArray): Boolean {
        val len = minOf(8192, bytes.size)
        for (i in 0 until len) {
            if (bytes[i].toInt() == 0) return true
        }
        return false
    }

    private fun errorObj(message: String): JsonObject {
        val obj = JsonObject()
        obj.addProperty("error", message)
        return obj
    }

    companion object {
        private const val MAX_BYTES = 5L * 1024 * 1024
        private const val MAX_WALK_DEPTH = 6
        private const val MAX_VISITED_DIRS = 5000

        private val SUBDIR_IGNORE = setOf(
            "node_modules", ".git", ".next", ".expo", "dist", "build", "out", ".cache",
            "coverage", ".turbo", ".parcel-cache", ".idea", ".vscode", ".vscode-test",
            "ios", "android",
            ".gradle", ".cxx", ".intellijPlatform", ".kotlin",
            "tmp", "target", "venv", ".venv", ".mypy_cache", ".pytest_cache",
            "__pycache__",
        )

        fun getInstance(): FileOpsService =
            ApplicationManager.getApplication().getService(FileOpsService::class.java)
    }
}
