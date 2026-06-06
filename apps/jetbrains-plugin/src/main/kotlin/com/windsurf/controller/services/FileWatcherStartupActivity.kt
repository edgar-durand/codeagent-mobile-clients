package com.windsurf.controller.services

// NOTE on doc comments: Kotlin block comments NEST. Single-line '//'
// comments only, per project memory.

import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.extensions.PluginId
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
            val telemetry = TelemetryService.getInstance()
            // Use the plugin's own per-install UUID as the anonymous
            // distinct id. `PermanentInstallationID.get()` was the
            // earlier anchor but returns the literal "0" when the
            // user hasn't opted into JetBrains' data-sharing policy —
            // and most devs don't. That collapsed every "private"
            // install into a single PostHog person (`jetbrains-0`),
            // hiding ~all real plugin_activated traffic behind one
            // distinct_id. `ensurePluginId()` is a per-install UUID
            // we already persist via SettingsService for backend
            // pairing, so the analytics ride the same identity the
            // server already knows about.
            telemetry.init(SettingsService.getInstance().ensurePluginId())
            telemetry.capture("plugin_activated", mapOf("surface" to "jetbrains"))

            // Marketplace update advisory - one-shot per IDE session
            // (the service self-guards), background-threaded, balloon
            // notification on stale install. Mirrors the CLI + VS
            // Code plugin update banners.
            runCatching {
                val pluginId = PluginId.getId("com.codeagent.mobile")
                val installedVersion =
                    PluginManagerCore.getPlugin(pluginId)?.version.orEmpty()
                UpdateNotifierService.getInstance().checkForUpdatesNow(installedVersion)
            }.onFailure { logger.debug("update-notifier wiring failed: ${it.message}") }

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
                    val u = pairing.pairedUser
                    if (u != null) {
                        telemetry.identify(
                            TelemetryService.IdentifyParams(
                                userId = u.email,
                                email = u.email,
                                name = u.name,
                                plan = u.plan,
                            )
                        )
                    }
                    telemetry.capture("plugin_paired", mapOf("plan" to (u?.plan ?: "unknown")))
                }
            })
        } catch (e: Exception) {
            logger.warn("FileWatcherStartupActivity failed: ${e.message}", e)
        }
    }
}
