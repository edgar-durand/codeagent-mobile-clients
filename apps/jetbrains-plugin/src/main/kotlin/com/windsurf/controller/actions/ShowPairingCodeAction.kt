package com.windsurf.controller.actions

import com.intellij.ide.BrowserUtil
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import com.windsurf.controller.services.PairingService
import com.windsurf.controller.services.PairingService.PairingCodeResult
import com.windsurf.controller.services.ProjectOpsService
import com.windsurf.controller.services.buildCloudFallbackMessage
import java.awt.Font
import java.net.URI
import javax.swing.JButton
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
            SwingUtilities.invokeLater {
                when (result) {
                    is PairingCodeResult.Code -> {
                        PairingCodeDialog(result.code, result.expiresAt, e).show()
                    }
                    PairingCodeResult.Blocked -> {
                        val ops = ProjectOpsService.getInstance()
                        val repo = ops.detectRepoSlug()
                        // detectCurrentBranch via gitStatus (already available)
                        val branch: String? = run {
                            val status = ops.gitStatus()
                            status.get("branch")?.takeIf { !it.isJsonNull }?.asString
                        }
                        val message = buildCloudFallbackMessage(repo, branch)
                        CloudFallbackDialog(message, e).show()
                    }
                    PairingCodeResult.None -> {
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
        private val event: AnActionEvent,
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

    /**
     * Cloud-fallback panel — rendered when the API host is unreachable (VPN/firewall/
     * allowlist) during a pairing attempt. Shows the title, body, numbered steps, and
     * optional repo·branch context line, plus:
     *  • **Retry** — re-invokes [ShowPairingCodeAction] so the user can try again after
     *    toggling VPN / allowlisting the host, without reopening the IDE menu.
     *  • **Learn more** — opens [learnMoreUrl] in the system browser via [BrowserUtil].
     *
     * Shown ONLY on an explicit pair attempt — never on auto-load.
     */
    private class CloudFallbackDialog(
        private val message: com.windsurf.controller.services.CloudFallbackMessage,
        private val event: AnActionEvent,
    ) : DialogWrapper(true) {

        init {
            title = message.title
            setOKButtonText("Retry")
            setCancelButtonText("Close")
            init()
        }

        override fun createCenterPanel(): JComponent {
            val panel = JPanel().apply {
                layout = BoxLayout(this, BoxLayout.Y_AXIS)
                border = JBUI.Borders.empty(4, 0, 4, 0)
            }

            // Body text
            panel.add(JBLabel("<html><body style='width:340px'>${message.body}</body></html>").apply {
                alignmentX = JComponent.LEFT_ALIGNMENT
            })

            panel.add(javax.swing.Box.createVerticalStrut(16))

            // Optional repo · branch line
            val repoLine = message.repoLine
            if (repoLine != null) {
                panel.add(JBLabel(repoLine).apply {
                    font = Font("Monospaced", Font.BOLD, 12)
                    foreground = java.awt.Color(108, 92, 231) // electric purple
                    alignmentX = JComponent.LEFT_ALIGNMENT
                })
                panel.add(javax.swing.Box.createVerticalStrut(12))
            }

            // Numbered steps
            message.steps.forEachIndexed { index, step ->
                panel.add(JBLabel("${index + 1}. $step").apply {
                    alignmentX = JComponent.LEFT_ALIGNMENT
                    border = JBUI.Borders.empty(2, 0)
                })
            }

            panel.add(javax.swing.Box.createVerticalStrut(16))

            // Learn more link
            val learnMoreBtn = JButton("Learn more").apply {
                alignmentX = JComponent.LEFT_ALIGNMENT
                isBorderPainted = false
                isContentAreaFilled = false
                foreground = java.awt.Color(88, 166, 255)
                cursor = java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
                font = font.deriveFont(Font.PLAIN, 12f)
            }
            learnMoreBtn.addActionListener {
                BrowserUtil.browse(URI(message.learnMoreUrl))
            }
            panel.add(learnMoreBtn)

            return panel
        }

        /** OK button → Retry: close this dialog and re-invoke the pairing action. */
        override fun doOKAction() {
            super.doOKAction()
            // Re-invoke on EDT after this dialog closes
            SwingUtilities.invokeLater {
                ShowPairingCodeAction().actionPerformed(event)
            }
        }
    }
}
