package com.windsurf.controller.ui

import com.intellij.ui.components.JBLabel
import com.windsurf.controller.services.SettingsService
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Component
import java.awt.Cursor
import java.awt.Dimension
import java.awt.Font
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JOptionPane
import javax.swing.JPanel
import javax.swing.border.EmptyBorder

/**
 * Builds a single row of the "Recent Sessions" rail. Each row shows
 * the user's name/email + a "Reconnect" or "Connected" badge + a
 * delete (✕) button that prompts for confirmation.
 *
 * Extracted from `ControllerToolWindowFactory.ControllerPanel.buildSessionRow`
 * so the row's UI shape lives next to the SessionRow construction
 * call site, not inline with 600+ LOC of panel lifecycle. The
 * factory holds the brand palette + the two callbacks the row
 * actions fire (reconnect / delete), so adding a new action means
 * editing this one file instead of widening the panel further.
 *
 * `parentForDialogs` is the Component the delete-confirmation
 * JOptionPane attaches to.
 */
internal class SessionRowFactory(
    private val accentGreen: Color,
    private val mutedText: Color,
    private val primaryText: Color,
    private val parentForDialogs: Component,
    private val onReconnect: (SettingsService.RecentSession) -> Unit,
    private val onDelete: (SettingsService.RecentSession) -> Unit,
) {

    fun build(
        session: SettingsService.RecentSession,
        isCurrentlyConnected: Boolean,
    ): JComponent {
        val row = JPanel(BorderLayout(8, 0)).apply {
            isOpaque = false
            border = EmptyBorder(6, 8, 6, 8)
            maximumSize = Dimension(Int.MAX_VALUE, 44)
            alignmentX = Component.LEFT_ALIGNMENT
        }

        val infoPanel = JPanel().apply {
            isOpaque = false
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
        }

        val nameLabel = JBLabel(session.userName.ifBlank { session.userEmail }).apply {
            font = font.deriveFont(Font.BOLD, 12f)
            foreground = primaryText
            alignmentX = Component.LEFT_ALIGNMENT
        }
        infoPanel.add(nameLabel)

        if (session.userName.isNotBlank() && session.userEmail.isNotBlank()) {
            val emailLabel = JBLabel(session.userEmail).apply {
                font = font.deriveFont(10f)
                foreground = mutedText
                alignmentX = Component.LEFT_ALIGNMENT
            }
            infoPanel.add(emailLabel)
        }

        row.add(infoPanel, BorderLayout.CENTER)

        val actionsPanel = JPanel().apply {
            isOpaque = false
            layout = BoxLayout(this, BoxLayout.X_AXIS)
        }

        if (isCurrentlyConnected) {
            val connectedLabel = JBLabel("Connected").apply {
                font = font.deriveFont(Font.BOLD, 10f)
                foreground = accentGreen
            }
            actionsPanel.add(connectedLabel)
        } else {
            val reconnectBtn = JButton("Reconnect").apply {
                font = font.deriveFont(10f)
                isFocusPainted = false
                putClientProperty("JButton.buttonType", "roundRect")
            }
            reconnectBtn.addActionListener {
                onReconnect(session)
            }
            actionsPanel.add(reconnectBtn)
        }

        actionsPanel.add(Box.createHorizontalStrut(4))

        val deleteBtn = JButton("✕").apply {
            font = font.deriveFont(10f)
            isFocusPainted = false
            toolTipText = "Delete session"
            putClientProperty("JButton.buttonType", "roundRect")
            preferredSize = Dimension(28, 28)
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        }
        deleteBtn.addActionListener {
            val confirm = JOptionPane.showConfirmDialog(
                parentForDialogs,
                "Delete this session? This action cannot be undone.",
                "Delete Session",
                JOptionPane.OK_CANCEL_OPTION,
                JOptionPane.WARNING_MESSAGE,
            )
            if (confirm == JOptionPane.OK_OPTION) {
                onDelete(session)
            }
        }
        actionsPanel.add(deleteBtn)

        row.add(actionsPanel, BorderLayout.EAST)

        return row
    }
}
