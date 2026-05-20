package com.windsurf.controller.services

// NOTE on doc comments: Kotlin block comments NEST. Single-line '//'
// comments only, per project memory.

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity

// Wires the FileWatcherService into the per-project lifecycle.
//
// Behaviour:
//   - On project open: register a PairingService listener so the
//     watcher starts the moment pairing completes.
//   - If a session was already paired before the project opened (e.g.
//     plugin reload, IDE restart with a sticky pluginAuthToken), kick
//     the watcher straight away with the existing session id.
//   - Project close is handled inside FileWatcherService itself via
//     ProjectManagerListener so we don't need a per-project Disposable
//     here.
class FileWatcherStartupActivity : ProjectActivity {

    private val logger = Logger.getInstance(FileWatcherStartupActivity::class.java)

    override suspend fun execute(project: Project) {
        if (project.isDisposed) return
        try {
            val watcher = FileWatcherService.getInstance()
            val pairing = PairingService.getInstance()

            // Drive #1 - existing pairing already on disk. We have a
            // token but no in-memory session id yet on plugin reload,
            // so we lift the session id from the most-recent recent-
            // sessions entry. The mobile keeps the same sessionId for
            // the duration of a pairing, so this stays correct after
            // an IDE restart.
            val existingSession = pairing.currentSessionId
                ?: SettingsService.getInstance().getRecentSessions().firstOrNull()?.sessionId

            val hasToken = SettingsService.getInstance().getPluginAuthToken() != null
            if (existingSession != null && hasToken) {
                watcher.start(project, existingSession)
            } else {
                // Still register the project so attachProject() can find
                // it without a basePath lookup race when pairing lands.
                // We avoid calling start() with an empty session id - the
                // listener below will start the global subscription on
                // first pairing.
            }

            // Drive #2 - listen for fresh pairings.
            pairing.addListener(object : PairingService.PairingListener {
                override fun onPaired(sessionId: String) {
                    try {
                        watcher.start(project, sessionId)
                    } catch (e: Exception) {
                        logger.warn(
                            "FileWatcherService.start failed: ${e.message}",
                            e,
                        )
                    }
                }
            })
        } catch (e: Exception) {
            logger.warn("FileWatcherStartupActivity failed: ${e.message}", e)
        }
    }
}
