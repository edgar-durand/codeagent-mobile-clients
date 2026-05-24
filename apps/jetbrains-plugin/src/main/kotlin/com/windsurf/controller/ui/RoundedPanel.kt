package com.windsurf.controller.ui

import java.awt.Color
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.RenderingHints
import java.awt.geom.RoundRectangle2D
import javax.swing.JPanel

/**
 * Swing panel with a rounded-rectangle background. Used as the
 * GlassCard surface on the pairing tool window (pairing card,
 * connected card, recent-sessions card). Extracted from
 * ControllerToolWindowFactory so the factory can stay focused on
 * lifecycle + layout assembly instead of carrying inline Swing
 * painters.
 *
 * Construction: pass `cornerRadius` (default 12px to match the
 * mobile DLS) and an optional `bgColor`. When `bgColor` is null,
 * the standard Swing `background` field drives the fill — useful
 * when the caller wants the panel to follow the IDE theme.
 */
internal class RoundedPanel(
    private val cornerRadius: Int = 12,
    private val bgColor: Color? = null,
) : JPanel() {

    init {
        isOpaque = false
    }

    override fun paintComponent(g: Graphics) {
        val g2 = g.create() as Graphics2D
        g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
        val fill = bgColor ?: background
        g2.color = fill
        g2.fill(
            RoundRectangle2D.Float(
                0f, 0f,
                width.toFloat(), height.toFloat(),
                cornerRadius.toFloat(), cornerRadius.toFloat(),
            ),
        )
        g2.dispose()
        super.paintComponent(g)
    }
}
