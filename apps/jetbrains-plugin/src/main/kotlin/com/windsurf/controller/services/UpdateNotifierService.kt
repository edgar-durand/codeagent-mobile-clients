package com.windsurf.controller.services

// Kotlin block comments NEST per project memory feedback_kotlin_
// nested_comments. Single-line '//' comments only inside this file.

import com.intellij.ide.BrowserUtil
import com.intellij.ide.plugins.PluginManagerConfigurable
import com.intellij.ide.util.PropertiesComponent
import com.intellij.notification.Notification
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.options.ShowSettingsUtil
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

// Application-scoped update notifier. On the first project-open of
// an IDE session (guard with `ranThisSession`) we ask the JetBrains
// Marketplace for the latest published build of
// `com.codeagent.mobile` and, when it's strictly newer than the
// currently installed version, surface a balloon notification with
// "Update now" / "Release notes" / "Later" actions. Behavior
// mirrors the CLI's auto-update advisory (apps/cli/src/lib/
// updateNotifier.ts) and the VS Code plugin's
// UpdateNotifierService (apps/vsc-plugin/src/services/
// update-notifier.service.ts).
//
// All "should we show?" decisions delegate to
// UpdateNotifierLogic (pure object) so JUnit can drive the rules
// without the IntelliJ Platform fixture. This shell only wires the
// real fetch, PropertiesComponent persistence, and the
// Notifications API.
@Service(Service.Level.APP)
class UpdateNotifierService {

    private val logger = Logger.getInstance(UpdateNotifierService::class.java)
    private val ranThisSession = AtomicBoolean(false)

    fun checkForUpdatesNow(currentVersion: String) {
        if (currentVersion.isBlank()) return
        if (!ranThisSession.compareAndSet(false, true)) return
        if (System.getenv("CODEAM_DISABLE_UPDATE_CHECK") == "1") return

        // Background thread: never block the EDT on a marketplace call.
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val latest = resolveLatestVersion() ?: return@executeOnPooledThread
                val dismissed = readDismissedVersion()
                when (UpdateNotifierLogic.decide(currentVersion, latest, dismissed)) {
                    UpdateNotifierLogic.Decision.SHOW ->
                        ApplicationManager.getApplication().invokeLater {
                            showUpdateBanner(currentVersion, latest)
                        }
                    UpdateNotifierLogic.Decision.UP_TO_DATE,
                    UpdateNotifierLogic.Decision.SUPPRESSED -> Unit
                }
            } catch (t: Throwable) {
                logger.debug("update-notifier failed: ${t.message}")
            }
        }
    }

    private fun resolveLatestVersion(): String? {
        val props = PropertiesComponent.getInstance()
        val fetchedAt = props.getLong(PROP_CACHE_TS, 0L)
        val cached = props.getValue(PROP_CACHE_VAL)
        if (cached != null && UpdateNotifierLogic.isCacheFresh(fetchedAt, System.currentTimeMillis())) {
            return cached
        }
        val fresh = fetchLatestFromMarketplace() ?: return cached
        props.setValue(PROP_CACHE_VAL, fresh)
        props.setValue(PROP_CACHE_TS, System.currentTimeMillis().toString())
        return fresh
    }

    private fun fetchLatestFromMarketplace(): String? {
        val url = URL("$MARKETPLACE_BASE/api/plugins/$PLUGIN_XML_ID/updates")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            setRequestProperty("Accept", "application/json")
            connectTimeout = 1500
            readTimeout = 1500
        }
        return try {
            if (conn.responseCode != 200) return null
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            UpdateNotifierLogic.parseLatestVersion(body)
        } catch (_: Throwable) {
            null
        } finally {
            conn.disconnect()
        }
    }

    private fun showUpdateBanner(currentVersion: String, latest: String) {
        val message =
            "CodeAgent Mobile $latest is available (you have $currentVersion). " +
                "Updating is recommended to fix known issues."
        val notification: Notification = NotificationGroupManager.getInstance()
            .getNotificationGroup(NOTIFICATION_GROUP)
            .createNotification(message, NotificationType.INFORMATION)

        notification.addAction(object : NotificationAction("Update now") {
            override fun actionPerformed(e: AnActionEvent, n: Notification) {
                ShowSettingsUtil.getInstance().showSettingsDialog(
                    e.project,
                    PluginManagerConfigurable::class.java,
                )
                n.expire()
            }
        })
        notification.addAction(object : NotificationAction("Release notes") {
            override fun actionPerformed(e: AnActionEvent, n: Notification) {
                BrowserUtil.browse("$MARKETPLACE_BASE/plugin/$PLUGIN_XML_ID")
                n.expire()
            }
        })
        notification.addAction(object : NotificationAction("Later") {
            override fun actionPerformed(e: AnActionEvent, n: Notification) {
                writeDismissedVersion(latest)
                n.expire()
            }
        })

        notification.notify(null)
    }

    private fun readDismissedVersion(): String? =
        PropertiesComponent.getInstance().getValue(PROP_DISMISSED_VAL)

    private fun writeDismissedVersion(version: String) {
        PropertiesComponent.getInstance().setValue(PROP_DISMISSED_VAL, version)
    }

    companion object {
        private const val PLUGIN_XML_ID = "com.codeagent.mobile"
        private const val MARKETPLACE_BASE = "https://plugins.jetbrains.com"
        private const val NOTIFICATION_GROUP = "CodeAgent-Mobile"
        private const val PROP_CACHE_TS = "codeam.updateNotifier.cache.ts"
        private const val PROP_CACHE_VAL = "codeam.updateNotifier.cache.val"
        private const val PROP_DISMISSED_VAL = "codeam.updateNotifier.dismissed"

        fun getInstance(): UpdateNotifierService =
            ApplicationManager.getApplication().getService(UpdateNotifierService::class.java)
    }
}
