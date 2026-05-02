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
 * Resolves paths against the open IntelliJ project's base directory and
 * refuses anything that escapes it. Writes go through `LocalFileSystem`
 * so the IDE's VFS picks up the change immediately (the editor refreshes,
 * indexers re-run, etc.) — same effect as the user typing in the IDE.
 */
@Service(Service.Level.APP)
class FileOpsService {

    fun readFile(rawPath: String): JsonObject {
        return try {
            val file = resolveSafe(rawPath) ?: return errorObj("Path escapes the open project.")
            if (!file.exists()) return errorObj("File not found.")
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
            val file = resolveSafe(rawPath) ?: return errorObj("Path escapes the open project.")
            val bytes = content.toByteArray(StandardCharsets.UTF_8)
            if (bytes.size > MAX_BYTES) return errorObj("Content too large.")

            // Ensure parent directories exist.
            file.parentFile?.let { parent ->
                if (!parent.exists()) parent.mkdirs()
            }

            // Write through the IDE's VFS so the editor picks up the change
            // and indexers / file watchers re-run as if the user had edited
            // the file natively.
            ApplicationManager.getApplication().invokeAndWait {
                ApplicationManager.getApplication().runWriteAction {
                    val vfile = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(file)
                    if (vfile != null) {
                        VfsUtil.saveText(vfile, content)
                    } else {
                        // File didn't exist yet — write directly, then refresh VFS.
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

    private fun resolveSafe(rawPath: String): File? {
        val projects = ProjectManager.getInstance().openProjects
        if (projects.isEmpty()) return null
        for (project in projects) {
            val basePath = project.basePath ?: continue
            val rootFile = File(basePath).canonicalFile
            val candidate = if (File(rawPath).isAbsolute) {
                File(rawPath).canonicalFile
            } else {
                File(rootFile, rawPath).canonicalFile
            }
            if (candidate == rootFile || candidate.path.startsWith(rootFile.path + File.separator)) {
                return candidate
            }
        }
        return null
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
        private const val MAX_BYTES = 5L * 1024 * 1024 // 5 MB

        fun getInstance(): FileOpsService =
            ApplicationManager.getApplication().getService(FileOpsService::class.java)
    }
}
