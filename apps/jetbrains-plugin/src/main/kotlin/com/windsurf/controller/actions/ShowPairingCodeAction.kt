package com.windsurf.controller.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import com.windsurf.controller.services.PairingService
import com.windsurf.controller.services.PairingService.PairingCodeResult
import com.windsurf.controller.services.ProjectOpsService
import com.windsurf.controller.services.buildCloudFallbackMessage
import com.windsurf.controller.ui.CloudFallbackDialog
import java.awt.Font
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.BoxLayout
import javax.swing.SwingConstants
import javax.swing.SwingUtilities

class ShowPairingCodeAction : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        // Run the network call off the EDT; dispatch the result back on the EDT.
        Thread {
            val result = PairingService.getInstance().requestPairingCode()
            when (result) {
                is PairingCodeResult.Code -> {
                    SwingUtilities.invokeLater {
                        PairingCodeDialog(result.code, result.expiresAt, e).show()
                    }
                }
                PairingCodeResult.Blocked -> {
                    // Compute git-derived context on the background thread (blocking git
                    // exec must NOT run on the EDT).
                    val ops = ProjectOpsService.getInstance()
                    val repo = ops.detectRepoSlug()
                    val branch: String? = run {
                        val status = ops.gitStatus()
                        status.get("branch")?.takeIf { !it.isJsonNull }?.asString
                    }
                    val message = buildCloudFallbackMessage(repo, branch)
                    // Marshal only the UI work to the EDT.
                    SwingUtilities.invokeLater {
                        CloudFallbackDialog(message, onRetry = {
                            ShowPairingCodeAction().actionPerformed(e)
                        }).show()
                    }
                }
                PairingCodeResult.None -> {
                    SwingUtilities.invokeLater {
                        com.intellij.openapi.ui.Messages.showErrorDialog(
                            e.project,
                            "Failed to generate pairing code. Check your connection and API settings.",
                            "Pairing Error"
                        )
                    }
                }
            }
        }.apply { isDaemon = true; start() }
    }

    private class PairingCodeDialog(
        private val code: String,
        private val expiresAt: Long,
        @Suppress("UNUSED_PARAMETER") event: AnActionEvent,
    ) : DialogWrapper(true) {

        init {
            title = "Mobile Pairing Code"
            init()
        }

        override fun createCenterPanel(): JComponent {
            val panel = JPanel().apply {
                layout = BoxLayout(this, BoxLayout.Y_AXIS)
                border = JBUI.Borders.empty(20)
            }

            panel.add(JBLabel("Enter this code in your mobile app:").apply {
                alignmentX = JComponent.CENTER_ALIGNMENT
            })

            panel.add(javax.swing.Box.createVerticalStrut(16))

            panel.add(JBLabel(code).apply {
                font = Font("Monospaced", Font.BOLD, 36)
                horizontalAlignment = SwingConstants.CENTER
                alignmentX = JComponent.CENTER_ALIGNMENT
            })

            panel.add(javax.swing.Box.createVerticalStrut(16))

            val remainingSec = ((expiresAt - System.currentTimeMillis()) / 1000).coerceAtLeast(0)
            panel.add(JBLabel("Code expires in ${remainingSec}s").apply {
                alignmentX = JComponent.CENTER_ALIGNMENT
                foreground = java.awt.Color.GRAY
            })

            return panel
        }
    }

}

