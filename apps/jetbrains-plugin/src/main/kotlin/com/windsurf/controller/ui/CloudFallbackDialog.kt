package com.windsurf.controller.ui

import com.intellij.ide.BrowserUtil
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import com.windsurf.controller.services.CloudFallbackMessage
import java.awt.Font
import java.net.URI
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.SwingUtilities

/**
 * Cloud-fallback panel — rendered when the API host is unreachable (VPN/firewall/
 * allowlist) during a pairing attempt. Shows the title, body, numbered steps, and
 * optional repo·branch context line, plus:
 *  • **Retry** — calls [onRetry] after closing so the caller can re-attempt pairing.
 *  • **Learn more** — opens [CloudFallbackMessage.learnMoreUrl] in the system browser
 *    via [BrowserUtil].
 *
 * Shown ONLY on an explicit pair attempt — never on auto-load. [onRetry] is
 * invoked on the EDT (inside [SwingUtilities.invokeLater]) after the dialog is
 * dismissed via the OK/Retry button.
 *
 * Both [com.windsurf.controller.actions.ShowPairingCodeAction] (Tools-menu action)
 * and [ControllerToolWindowFactory] (primary "Generate Code" button) construct this
 * class directly, passing their own [onRetry] lambdas. The dialog itself has no
 * knowledge of either surface — it only calls back.
 */
internal class CloudFallbackDialog(
    private val message: CloudFallbackMessage,
    private val onRetry: () -> Unit,
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

    /** OK button → Retry: close this dialog then invoke [onRetry] on the EDT. */
    override fun doOKAction() {
        super.doOKAction()
        SwingUtilities.invokeLater { onRetry() }
    }
}
