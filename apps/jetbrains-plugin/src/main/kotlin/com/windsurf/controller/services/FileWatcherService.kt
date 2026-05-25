package com.windsurf.controller.services

// NOTE on doc comments: Kotlin block comments NEST. We use single-line
// '//' doc comments here to avoid the "Missing '}' / Unclosed comment
// past EOF" trap noted in project memory.

import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.project.ProjectManagerListener
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileContentChangeEvent
import com.intellij.openapi.vfs.newvfs.events.VFileCopyEvent
import com.intellij.openapi.vfs.newvfs.events.VFileCreateEvent
import com.intellij.openapi.vfs.newvfs.events.VFileDeleteEvent
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.openapi.vfs.newvfs.events.VFileMoveEvent
import com.windsurf.controller.protocol.PROTOCOL_VERSION
import com.windsurf.controller.services.filewatcher.DiffParser
import com.windsurf.controller.services.filewatcher.FileChangeStatus
import com.windsurf.controller.services.filewatcher.FileReviewStatus
import com.windsurf.controller.services.filewatcher.HunkLine
import com.windsurf.controller.services.strategies.AgentStrategyRegistry
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.nio.file.Path
import java.nio.file.Paths
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

// Path B file-watcher service - the Kotlin equivalent of the CLI's
// chokidar-based FileWatcherService and the VS Code plugin's filesystem
// watcher.
//
// When the JetBrains plugin drives an agent directly (without spawning
// the CLI), file changes inside the workspace must be POSTed to the
// backend's /api/files/changed + /api/review/hunks endpoints so the
// mobile Pending Review Queue and Files screen populate.
//
// Lifecycle:
//   - registered as an application service in plugin.xml
//   - .start() is called from PairingService listener when pairing
//     succeeds
//   - per-project state is created on demand via attachProject()
//   - per-project state is torn down on project close (ProjectManager-
//     Listener) or full .stop()
//
// Detection:
//   - BulkFileListener fires on VFS commits (saves), NOT keystrokes -
//     this is the listener API we want; FileDocumentManagerListener
//     also fires on save, but BulkFileListener gives us deletes and
//     creates in the same callback which keeps the wiring uniform.
//
// Activity heuristic:
//   - Emissions are gated on AgentStrategyRegistry.recentlyActive() so
//     human edits between agent runs do not flood the queue. The window
//     opens on every agent invocation and stays open for
//     AGENT_ACTIVE_WINDOW_MS afterwards.
@Service(Service.Level.APP)
class FileWatcherService {

    private val logger = Logger.getInstance(FileWatcherService::class.java)
    private val gson = Gson()

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    private val scheduler: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "codeagent-file-watcher").apply { isDaemon = true }
        }

    private val running = AtomicBoolean(false)

    // Per-project state. Keyed by Project so multi-window IDE installs
    // (e.g. two projects open at once) each get their own watcher and
    // never share session ids or pending debounces.
    private val projects = ConcurrentHashMap<Project, ProjectWatcher>()

    // Cache of (file directory -> enclosing git root). Resolved lazily
    // per event so sub-repos that appear after pairing light up
    // automatically; cached so a hot session does not re-stat the
    // filesystem on every save. Empty string = no enclosing repo.
    private val gitRootByDir = ConcurrentHashMap<String, String>()

    private var busConnection: com.intellij.util.messages.MessageBusConnection? = null
    private var projectMgrConnection: com.intellij.util.messages.MessageBusConnection? = null

    // Container for everything we need to know about a watched project.
    // Pending writes are coalesced per (project, relPath) by the
    // ProjectWatcher itself - chokidar's debounce gets re-implemented
    // here via ScheduledFuture cancel + reschedule.
    private class ProjectWatcher(
        val project: Project,
        val workingDir: Path,
        @Volatile var sessionId: String,
        val pending: ConcurrentHashMap<String, PendingEmit> = ConcurrentHashMap(),
    )

    private class PendingEmit(
        @Volatile var future: ScheduledFuture<*>,
        @Volatile var changeType: ChangeType,
    )

    private enum class ChangeType { ADD, CHANGE, UNLINK }

    // Start the global VFS subscription + project-close listener.
    // Idempotent: subsequent calls re-bind the sessionId on the current
    // project (for re-pairings) but do not double-subscribe.
    fun start(project: Project, sessionId: String) {
        if (!running.compareAndSet(false, true)) {
            // Already running globally - just bind/update the project.
            attachProject(project, sessionId)
            return
        }
        val app = ApplicationManager.getApplication()
        val conn = app.messageBus.connect()
        conn.subscribe(
            com.intellij.openapi.vfs.VirtualFileManager.VFS_CHANGES,
            object : BulkFileListener {
                override fun after(events: MutableList<out VFileEvent>) {
                    handleVfsEvents(events)
                }
            },
        )
        busConnection = conn

        val pmConn = app.messageBus.connect()
        pmConn.subscribe(
            ProjectManager.TOPIC,
            object : ProjectManagerListener {
                override fun projectClosing(project: Project) {
                    detachProject(project)
                }
            },
        )
        projectMgrConnection = pmConn

        attachProject(project, sessionId)
        logger.info(
            "FileWatcherService started (project=${project.name} session=${sessionId.take(8)})",
        )
    }

    // Update or insert a project to watch. Used when a fresh pairing
    // completes after the global listener is already up.
    fun attachProject(project: Project, sessionId: String) {
        if (project.isDisposed) return
        val basePath = project.basePath
        if (basePath.isNullOrBlank()) {
            logger.warn("attachProject: project ${project.name} has no basePath - skipping")
            return
        }
        val root = Paths.get(basePath).toAbsolutePath().normalize()
        projects.compute(project) { _, existing ->
            if (existing != null) {
                existing.sessionId = sessionId
                existing
            } else {
                ProjectWatcher(project, root, sessionId)
            }
        }
        logger.info(
            "Watching ${root} for project=${project.name} session=${sessionId.take(8)}",
        )
    }

    fun detachProject(project: Project) {
        val watcher = projects.remove(project) ?: return
        for (pending in watcher.pending.values) {
            pending.future.cancel(false)
        }
        watcher.pending.clear()
        logger.info("Stopped watching project=${project.name}")
    }

    // Tear everything down - called on plugin shutdown / explicit
    // disconnect. Safe to call multiple times.
    fun stop() {
        if (!running.compareAndSet(true, false)) return
        for (project in projects.keys.toList()) {
            detachProject(project)
        }
        try { busConnection?.disconnect() } catch (e: Exception) {
            logger.debug("busConnection.disconnect: ${e.message}")
        }
        busConnection = null
        try { projectMgrConnection?.disconnect() } catch (e: Exception) {
            logger.debug("projectMgrConnection.disconnect: ${e.message}")
        }
        projectMgrConnection = null
        logger.info("FileWatcherService stopped")
    }

    // ─── VFS event handling ────────────────────────────────────────────

    private fun handleVfsEvents(events: List<VFileEvent>) {
        if (!running.get()) return
        if (projects.isEmpty()) return

        // Only emit when an agent is actively producing output. Without
        // this gate, every human save floods the review queue.
        if (!AgentStrategyRegistry.getInstance().recentlyActive()) return

        for (event in events) {
            val (file, changeType) = classify(event) ?: continue
            if (file == null) continue
            if (file.isDirectory) continue
            val absPath = file.path

            // Find the project whose root contains this file. Projects
            // is small (typically 1, rarely 2-3) so a linear scan is
            // fine and avoids a global path-trie.
            val watcher = projects.values.firstOrNull { w ->
                isInside(w.workingDir, absPath)
            } ?: continue

            if (shouldIgnore(watcher.workingDir, absPath)) continue
            schedule(watcher, absPath, changeType)
        }
    }

    private fun classify(event: VFileEvent): Pair<VirtualFile?, ChangeType>? = when (event) {
        is VFileContentChangeEvent -> event.file to ChangeType.CHANGE
        is VFileCreateEvent -> event.file to ChangeType.ADD
        is VFileCopyEvent -> event.findCreatedFile() to ChangeType.ADD
        is VFileDeleteEvent -> event.file to ChangeType.UNLINK
        is VFileMoveEvent -> event.file to ChangeType.CHANGE
        else -> null
    }

    // ─── Debounce + emit ───────────────────────────────────────────────

    private fun schedule(
        watcher: ProjectWatcher,
        absPath: String,
        changeType: ChangeType,
    ) {
        if (!running.get()) return
        val existing = watcher.pending[absPath]
        existing?.future?.cancel(false)

        val future = scheduler.schedule({
            watcher.pending.remove(absPath)
            try {
                emitForFile(watcher, absPath, changeType)
            } catch (e: Exception) {
                logger.warn("emitForFile failed for $absPath: ${e.message}", e)
            }
        }, DEBOUNCE_MS, TimeUnit.MILLISECONDS)

        if (existing == null) {
            watcher.pending[absPath] = PendingEmit(future, changeType)
        } else {
            existing.future = future
            existing.changeType = changeType
        }
    }

    // Visible for tests so JUnit can pump a synthetic VFS event through
    // the debounce + emit pipeline without touching the real platform.
    internal fun scheduleForTest(
        project: Project,
        absPath: String,
        changeType: String,
    ) {
        val watcher = projects[project] ?: return
        val mapped = when (changeType) {
            "add" -> ChangeType.ADD
            "change" -> ChangeType.CHANGE
            "unlink" -> ChangeType.UNLINK
            else -> return
        }
        schedule(watcher, absPath, mapped)
    }

    private fun emitForFile(
        watcher: ProjectWatcher,
        absPath: String,
        changeType: ChangeType,
    ) {
        // Resolve the file's enclosing git repo. The project basePath
        // can be an umbrella directory holding several sibling
        // repositories (each with its own .git/); running git diff
        // from the umbrella would return null and we'd ship zero-stat
        // rows. Walk up from the file and cache per directory so a
        // busy session doesn't re-stat the world.
        val fileDir = try {
            Paths.get(absPath).toAbsolutePath().normalize().parent
        } catch (e: Exception) {
            logger.debug("resolve parent failed for $absPath: ${e.message}")
            null
        } ?: return

        val gitRoot = gitRootByDir.computeIfAbsent(fileDir.toString()) {
            findGitRoot(fileDir)?.toString() ?: ""
        }.let { if (it.isEmpty()) null else Paths.get(it) }

        if (gitRoot == null) {
            logger.debug("no enclosing git repo for $absPath - suppressing emit")
            return
        }

        val relPath = relativise(gitRoot, absPath) ?: return
        if (relPath.isEmpty() || relPath.startsWith("..")) return

        // repoPath is the git root relative to the project basePath
        // so the UI can render a repo chip per row. Empty when the
        // project basePath IS the repo root.
        val repoPath = try {
            watcher.workingDir.relativize(gitRoot).toString().replace(File.separatorChar, '/')
        } catch (e: Exception) {
            ""
        }
        val repoName = gitRoot.fileName?.toString() ?: ""

        val pluginId = SettingsService.getInstance().ensurePluginId()
        val sessionId = watcher.sessionId

        if (changeType == ChangeType.UNLINK) {
            val diff = gitDiff(gitRoot, relPath)
            if (diff.isNullOrBlank()) {
                // Untracked-and-removed: ship a zero-stat deletion so
                // the Files screen drops the row.
                postFileChanged(
                    sessionId = sessionId,
                    pluginId = pluginId,
                    filePath = relPath,
                    fileStatus = FileChangeStatus.DELETED,
                    linesAdded = 0,
                    linesRemoved = 0,
                    hunkCount = 0,
                    reviewStatus = null,
                    repoPath = repoPath,
                    repoName = repoName,
                )
                return
            }
            val parsed = DiffParser.parseUnifiedDiff(diff)
            postFileChanged(
                sessionId = sessionId,
                pluginId = pluginId,
                filePath = relPath,
                fileStatus = FileChangeStatus.DELETED,
                linesAdded = parsed.totalLinesAdded,
                linesRemoved = parsed.totalLinesRemoved,
                hunkCount = parsed.hunks.size,
                reviewStatus = if (parsed.hunks.isNotEmpty()) FileReviewStatus.AWAITING_REVIEW else null,
                repoPath = repoPath,
                repoName = repoName,
            )
            for (hunk in parsed.hunks) {
                postReviewHunk(
                    sessionId = sessionId,
                    pluginId = pluginId,
                    filePath = relPath,
                    fileStatus = FileChangeStatus.DELETED,
                    header = hunk.header,
                    lines = hunk.lines,
                    linesAdded = hunk.linesAdded,
                    linesRemoved = hunk.linesRemoved,
                )
            }
            return
        }

        val diff = gitDiff(gitRoot, relPath)
        if (diff == null) {
            // git failed even though we found a .git/ directory.
            // Skip silently rather than poison the rail with zeros.
            logger.warn("git diff failed for $relPath in $gitRoot - suppressing emit")
            return
        }

        val parsed = DiffParser.parseUnifiedDiff(diff)
        // Suppress no-op touches so filesystem syncs (git pull, format-
        // on-save with no diff, IDE indexer) don't pollute the rail.
        if (parsed.totalLinesAdded == 0 && parsed.totalLinesRemoved == 0 && parsed.hunks.isEmpty()) {
            return
        }

        val derivedStatus: FileChangeStatus = if (parsed.fileStatus != FileChangeStatus.MODIFIED) {
            parsed.fileStatus
        } else {
            when (changeType) {
                ChangeType.ADD -> FileChangeStatus.ADDED
                ChangeType.UNLINK -> FileChangeStatus.DELETED
                ChangeType.CHANGE -> FileChangeStatus.MODIFIED
            }
        }
        val reviewStatus = if (parsed.hunks.isNotEmpty()) FileReviewStatus.AWAITING_REVIEW else null

        postFileChanged(
            sessionId = sessionId,
            pluginId = pluginId,
            filePath = relPath,
            fileStatus = derivedStatus,
            linesAdded = parsed.totalLinesAdded,
            linesRemoved = parsed.totalLinesRemoved,
            hunkCount = parsed.hunks.size,
            reviewStatus = reviewStatus,
            repoPath = repoPath,
            repoName = repoName,
        )
        for (hunk in parsed.hunks) {
            postReviewHunk(
                sessionId = sessionId,
                pluginId = pluginId,
                filePath = relPath,
                fileStatus = derivedStatus,
                header = hunk.header,
                lines = hunk.lines,
                linesAdded = hunk.linesAdded,
                linesRemoved = hunk.linesRemoved,
            )
        }
    }

    // ─── HTTP POSTs ────────────────────────────────────────────────────

    private fun postFileChanged(
        sessionId: String,
        pluginId: String,
        filePath: String,
        fileStatus: FileChangeStatus,
        linesAdded: Int,
        linesRemoved: Int,
        hunkCount: Int,
        reviewStatus: FileReviewStatus?,
        repoPath: String = "",
        repoName: String = "",
    ) {
        val body = JsonObject().apply {
            addProperty("sessionId", sessionId)
            addProperty("pluginId", pluginId)
            addProperty("filePath", filePath)
            addProperty("fileStatus", fileStatus.wire)
            addProperty("linesAdded", linesAdded)
            addProperty("linesRemoved", linesRemoved)
            addProperty("hunkCount", hunkCount)
            if (reviewStatus != null) {
                addProperty("reviewStatus", reviewStatus.wire)
            }
            // Optional repo attribution (additive — older backends
            // ignore these). Skip empty strings so single-repo
            // workspaces don't lint noise into the payload.
            if (repoPath.isNotEmpty()) addProperty("repoPath", repoPath)
            if (repoName.isNotEmpty()) addProperty("repoName", repoName)
        }
        postWithRetries(
            "${SettingsService.getInstance().state.apiBaseUrl}/api/files/changed",
            body,
            filePath,
        )
    }

    private fun postReviewHunk(
        sessionId: String,
        pluginId: String,
        filePath: String,
        fileStatus: FileChangeStatus,
        header: String,
        lines: List<HunkLine>,
        linesAdded: Int,
        linesRemoved: Int,
    ) {
        val lineArr = JsonArray()
        for (line in lines) {
            lineArr.add(JsonObject().apply {
                addProperty("type", line.type.wire)
                addProperty("lineNumber", line.lineNumber)
                addProperty("text", line.text)
            })
        }
        val body = JsonObject().apply {
            addProperty("sessionId", sessionId)
            addProperty("pluginId", pluginId)
            addProperty("filePath", filePath)
            addProperty("fileStatus", fileStatus.wire)
            addProperty("hunkHeader", header)
            add("lines", lineArr)
            addProperty("linesAdded", linesAdded)
            addProperty("linesRemoved", linesRemoved)
        }
        postWithRetries(
            "${SettingsService.getInstance().state.apiBaseUrl}/api/review/hunks",
            body,
            filePath,
        )
    }

    private fun postWithRetries(url: String, body: JsonObject, filePathForLog: String) {
        val payload = gson.toJson(body)
        scheduler.execute {
            var attempt = 0
            while (attempt <= MAX_RETRIES) {
                val request = Request.Builder()
                    .url(url)
                    .post(payload.toRequestBody("application/json".toMediaType()))
                    .addHeader("X-Codeam-Protocol-Version", PROTOCOL_VERSION)
                    .also { b ->
                        SettingsService.getInstance().getPluginAuthToken()?.let {
                            b.addHeader("X-Plugin-Auth-Token", it)
                        }
                    }
                    .build()
                try {
                    httpClient.newCall(request).execute().use { response ->
                        val code = response.code
                        if (code in 200..299) {
                            logger.debug(
                                "post ok url=$url status=$code path=$filePathForLog",
                            )
                            return@execute
                        }
                        if (code == 404 || code == 410) {
                            // Session is gone - stop pestering the API.
                            logger.warn(
                                "session dead (status=$code) - dropping $filePathForLog",
                            )
                            return@execute
                        }
                        val errBody = try {
                            response.body.string().take(200)
                        } catch (e: Exception) {
                            "<err: ${e.message}>"
                        }
                        logger.warn(
                            "post failed url=$url status=$code attempt=${attempt + 1} body=$errBody",
                        )
                    }
                } catch (e: Exception) {
                    logger.warn(
                        "post error url=$url attempt=${attempt + 1}: ${e.message}",
                    )
                }
                attempt += 1
                if (attempt <= MAX_RETRIES) {
                    try {
                        Thread.sleep(RETRY_BACKOFF_MS * attempt)
                    } catch (_: InterruptedException) {
                        Thread.currentThread().interrupt()
                        return@execute
                    }
                }
            }
            logger.warn(
                "giving up after ${MAX_RETRIES + 1} attempts - path=$filePathForLog",
            )
        }
    }

    // ─── git helpers ───────────────────────────────────────────────────

    // Compute the unified diff for a single path relative to the
    // working dir. Returns null when git is unavailable or the cwd is
    // not a repo. Returns "" when there is no diff (e.g. a touch that
    // did not change content).
    //
    // For tracked files: git diff --no-color -- <path> (worktree vs HEAD).
    // For untracked files: git diff --no-color --no-index /dev/null <path>
    // (added-shaped diff against an empty source).
    private fun gitDiff(cwd: Path, relPath: String): String? {
        val tracked = runGit(cwd, listOf("diff", "--no-color", "--", relPath))
            ?: return null
        if (tracked.isNotBlank()) return tracked

        val devNull = if (System.getProperty("os.name").startsWith("Windows", ignoreCase = true)) {
            "NUL"
        } else {
            "/dev/null"
        }
        val untracked = runGit(
            cwd = cwd,
            args = listOf("diff", "--no-color", "--no-index", "--", devNull, relPath),
            allowNonZeroExit = true,
        )
        return untracked ?: ""
    }

    // Test seam: callers can swap this lambda in tests to short-circuit
    // git entirely. Defaults to a real git subprocess.
    internal var runGitImpl: (Path, List<String>, Boolean) -> String? =
        ::defaultRunGit

    private fun runGit(
        cwd: Path,
        args: List<String>,
        allowNonZeroExit: Boolean = false,
    ): String? = runGitImpl(cwd, args, allowNonZeroExit)

    private fun defaultRunGit(
        cwd: Path,
        args: List<String>,
        allowNonZeroExit: Boolean,
    ): String? {
        val cmd = listOf("git") + args
        val pb = ProcessBuilder(cmd)
            .directory(cwd.toFile())
            .redirectErrorStream(false)
        return try {
            val proc = pb.start()
            val stdout = proc.inputStream.bufferedReader().readText()
            val stderr = proc.errorStream.bufferedReader().readText()
            val finished = proc.waitFor(15, TimeUnit.SECONDS)
            if (!finished) {
                proc.destroyForcibly()
                logger.debug("git ${args.joinToString(" ")} timed out")
                return null
            }
            val code = proc.exitValue()
            if (code == 0 || allowNonZeroExit) {
                stdout
            } else {
                logger.debug(
                    "git ${args.joinToString(" ")} exited $code stderr=${stderr.take(200)}",
                )
                null
            }
        } catch (e: Exception) {
            logger.debug("git spawn failed: ${e.message}")
            null
        }
    }

    // ─── path helpers ──────────────────────────────────────────────────

    // Walk up from startDir until we find a directory that contains a
    // .git entry (regular .git dir, or a `gitdir: ...` file used by
    // worktrees / submodules). Returns the discovered repo root or
    // null when we reach the filesystem root without finding one.
    //
    // Mirrors the CLI's findGitRoot helper - matters when the project
    // basePath is an umbrella directory holding several sibling
    // repositories so each file gets attributed to its actual repo
    // instead of the non-git parent.
    internal fun findGitRoot(startDir: Path): Path? {
        var dir: Path? = startDir.toAbsolutePath().normalize()
        var hops = 0
        while (dir != null && hops < 256) {
            val gitFile = dir.resolve(".git").toFile()
            if (gitFile.exists()) return dir
            val parent = dir.parent
            if (parent == null || parent == dir) return null
            dir = parent
            hops += 1
        }
        return null
    }

    private fun isInside(root: Path, absPath: String): Boolean {
        return try {
            val abs = Paths.get(absPath).toAbsolutePath().normalize()
            abs.startsWith(root)
        } catch (e: Exception) {
            false
        }
    }

    private fun relativise(root: Path, absPath: String): String? {
        return try {
            val abs = Paths.get(absPath).toAbsolutePath().normalize()
            val rel = root.relativize(abs).toString()
            // Always emit forward-slash paths on the wire so the backend
            // and mobile UI don't have to special-case Windows.
            rel.replace(File.separatorChar, '/')
        } catch (e: Exception) {
            null
        }
    }

    // Filter heuristic - skip noise the agent would never edit and
    // common build outputs that the agent regenerates every run.
    private fun shouldIgnore(root: Path, absPath: String): Boolean {
        val rel = relativise(root, absPath) ?: return true
        if (rel.isEmpty()) return true
        for (segment in rel.split('/')) {
            if (segment.startsWith(".")) return true
            if (IGNORE_SEGMENTS.contains(segment)) return true
        }
        return false
    }

    companion object {
        // Debounce window per file. Rapid sequential writes coalesce so
        // a single save doesn't fire 3 separate emits (VFS + indexer +
        // formatter triggers).
        const val DEBOUNCE_MS = 250L

        // Retry budget per emission on transient HTTP failure.
        const val MAX_RETRIES = 2

        // Linear backoff between retries.
        const val RETRY_BACKOFF_MS = 300L

        // Directories that the agent never edits (and that the IDE
        // touches constantly during builds). Mirrors the CLI's chokidar
        // ignore list.
        private val IGNORE_SEGMENTS = setOf(
            "node_modules",
            "dist",
            "build",
            "out",
            "coverage",
            "target",
            "__pycache__",
            ".gradle",
            ".idea",
            ".turbo",
            ".cache",
            ".parcel-cache",
        )

        fun getInstance(): FileWatcherService =
            ApplicationManager.getApplication().getService(FileWatcherService::class.java)
    }
}
