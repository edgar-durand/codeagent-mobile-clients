package com.windsurf.controller.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import com.windsurf.controller.services.PairingService
import java.awt.Font
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.BoxLayout
import javax.swing.SwingConstants

class ShowPairingCodeAction : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val result = PairingService.getInstance().requestPairingCode()

        if (result != null) {
            PairingCodeDialog(result.code, result.expiresAt).show()
        } else {
            com.intellij.openapi.ui.Messages.showErrorDialog(
                e.project,
                "Failed to generate pairing code. Check your connection and API settings.",
                "Pairing Error"
            )
        }
    }

    private class PairingCodeDialog(
        private val code: String,
        private val expiresAt: Long
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
