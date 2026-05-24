package com.windsurf.controller.ui

import java.awt.BasicStroke
import java.awt.Color
import java.awt.Dimension
import java.awt.Font
import java.awt.GradientPaint
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.RenderingHints
import java.awt.geom.Arc2D
import java.awt.geom.CubicCurve2D
import java.awt.geom.Ellipse2D
import java.awt.geom.Path2D
import java.awt.geom.RoundRectangle2D
import javax.swing.JPanel
import javax.swing.Timer

/**
 * Animated paired-device illustration: phone (left) + computer
 * (right) with a Bézier arc + dotted-light data stream connecting
 * them, plus an inline user-info card below. Driven by a 40 ms
 * Swing Timer that increments the animation phase + repaints.
 *
 * Extracted from ControllerToolWindowFactory so the factory can
 * stay focused on lifecycle / layout assembly instead of carrying
 * ~245 LOC of inline Java2D paint code.
 *
 * Construction: passes the brand palette (accentBlue for the
 * data-stream gradient, accentGreen for the status dots) + the
 * paired user's name/email/plan for the card. The panel owns no
 * state beyond the two animation phases — repaints derive from the
 * timer alone.
 */
internal class DeviceConnectionPanel(
    private val accentBlue: Color,
    private val accentGreen: Color,
    private val mutedText: Color,
    private val primaryText: Color,
    private val userName: String,
    private val userEmail: String,
    private val userPlan: String,
) : JPanel() {

    private var animPhase = 0.0
    private var pulsePhase = 0.0
    private val animTimer = Timer(40) {
        animPhase = (animPhase + 0.018) % 1.0
        pulsePhase = (pulsePhase + 0.06) % (Math.PI * 2)
        repaint()
    }

    init {
        isOpaque = false
        preferredSize = Dimension(320, 250)
        minimumSize = Dimension(260, 230)
        maximumSize = Dimension(Int.MAX_VALUE, 270)
    }

    override fun addNotify() {
        super.addNotify()
        animTimer.start()
    }

    override fun removeNotify() {
        animTimer.stop()
        super.removeNotify()
    }

    override fun paintComponent(g: Graphics) {
        super.paintComponent(g)
        val g2 = g.create() as Graphics2D
        g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
        g2.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON)
        g2.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY)

        val w = width
        val h = height
        val cx = w / 2

        val phoneX = 16
        val phoneY = 38
        val phoneW = 34
        val phoneH = 58

        val pcX = w - 62
        val pcY = 36
        val pcW = 48
        val pcH = 36

        drawAnimatedArc(g2, phoneX + phoneW + 4, phoneY + 12, pcX - 4, pcY + 12, cx, 10)

        drawMobilePhone(g2, phoneX, phoneY, phoneW, phoneH)
        drawComputer(g2, pcX, pcY, pcW, pcH)

        val pulse = (Math.sin(pulsePhase) * 0.35 + 0.65).toFloat()
        val dotAlpha = (255 * pulse).toInt().coerceIn(120, 255)
        g2.color = Color(accentGreen.red, accentGreen.green, accentGreen.blue, dotAlpha)
        g2.fill(Ellipse2D.Float((phoneX + phoneW - 3).toFloat(), (phoneY - 3).toFloat(), 7f, 7f))
        g2.fill(Ellipse2D.Float((pcX + pcW - 5).toFloat(), (pcY - 3).toFloat(), 7f, 7f))

        g2.color = primaryText
        g2.font = g2.font.deriveFont(Font.BOLD, 13f)
        val titleText = "Paired Device"
        val titleFm = g2.fontMetrics
        g2.drawString(titleText, cx - titleFm.stringWidth(titleText) / 2, 22)

        drawUserInfo(g2, cx, 108)

        g2.dispose()
    }

    private fun drawMobilePhone(g2: Graphics2D, x: Int, y: Int, w: Int, h: Int) {
        g2.color = Color(0, 0, 0, 25)
        g2.fill(RoundRectangle2D.Float((x + 2).toFloat(), (y + 2).toFloat(), w.toFloat(), h.toFloat(), 10f, 10f))

        g2.color = Color(52, 52, 58)
        g2.fill(RoundRectangle2D.Float(x.toFloat(), y.toFloat(), w.toFloat(), h.toFloat(), 10f, 10f))

        g2.color = Color(72, 72, 78)
        g2.stroke = BasicStroke(0.8f)
        g2.draw(RoundRectangle2D.Float(x.toFloat(), y.toFloat(), w.toFloat(), h.toFloat(), 10f, 10f))

        val sx = x + 3; val sy = y + 8; val sw = w - 6; val sh = h - 16
        g2.color = Color(22, 24, 30)
        g2.fill(RoundRectangle2D.Float(sx.toFloat(), sy.toFloat(), sw.toFloat(), sh.toFloat(), 4f, 4f))

        g2.paint = GradientPaint(sx.toFloat(), sy.toFloat(), Color(accentBlue.red, accentBlue.green, accentBlue.blue, 35),
            sx.toFloat(), (sy + sh).toFloat(), Color(accentBlue.red, accentBlue.green, accentBlue.blue, 10))
        g2.fill(RoundRectangle2D.Float(sx.toFloat(), sy.toFloat(), sw.toFloat(), sh.toFloat(), 4f, 4f))

        g2.color = Color(accentBlue.red, accentBlue.green, accentBlue.blue, 50)
        g2.stroke = BasicStroke(1f)
        for (i in 0 until 3) {
            val ly = sy + 7 + i * 9
            val lw = sw - 10 - i * 5
            if (ly < sy + sh - 5) g2.drawLine(sx + 5, ly, sx + 5 + lw, ly)
        }

        g2.color = Color(90, 90, 96)
        g2.fill(RoundRectangle2D.Float((x + w / 2 - 5).toFloat(), (y + h - 5).toFloat(), 10f, 2.5f, 1.5f, 1.5f))

        g2.color = Color(70, 70, 76)
        g2.fill(RoundRectangle2D.Float((x + w / 2 - 4).toFloat(), (y + 3).toFloat(), 8f, 2f, 1f, 1f))
    }

    private fun drawComputer(g2: Graphics2D, x: Int, y: Int, w: Int, h: Int) {
        g2.color = Color(0, 0, 0, 25)
        g2.fill(RoundRectangle2D.Float((x + 2).toFloat(), (y + 2).toFloat(), w.toFloat(), h.toFloat(), 6f, 6f))

        g2.color = Color(52, 52, 58)
        g2.fill(RoundRectangle2D.Float(x.toFloat(), y.toFloat(), w.toFloat(), h.toFloat(), 6f, 6f))

        g2.color = Color(72, 72, 78)
        g2.stroke = BasicStroke(0.8f)
        g2.draw(RoundRectangle2D.Float(x.toFloat(), y.toFloat(), w.toFloat(), h.toFloat(), 6f, 6f))

        val sx = x + 3; val sy = y + 3; val sw = w - 6; val sh = h - 8
        g2.color = Color(22, 24, 30)
        g2.fill(RoundRectangle2D.Float(sx.toFloat(), sy.toFloat(), sw.toFloat(), sh.toFloat(), 3f, 3f))

        g2.paint = GradientPaint(sx.toFloat(), sy.toFloat(), Color(accentBlue.red, accentBlue.green, accentBlue.blue, 35),
            sx.toFloat(), (sy + sh).toFloat(), Color(accentBlue.red, accentBlue.green, accentBlue.blue, 10))
        g2.fill(RoundRectangle2D.Float(sx.toFloat(), sy.toFloat(), sw.toFloat(), sh.toFloat(), 3f, 3f))

        g2.color = Color(accentBlue.red, accentBlue.green, accentBlue.blue, 45)
        g2.stroke = BasicStroke(1f)
        val colors = arrayOf(
            Color(accentBlue.red, accentBlue.green, accentBlue.blue, 45),
            Color(52, 199, 89, 45),
            Color(255, 149, 0, 35),
            Color(accentBlue.red, accentBlue.green, accentBlue.blue, 35),
        )
        for (i in 0 until 4) {
            val ly = sy + 5 + i * 5
            val lw = sw - 10 - ((i * 7 + 3) % 14)
            if (ly < sy + sh - 4) {
                g2.color = colors[i % colors.size]
                g2.drawLine(sx + 5, ly, sx + 5 + lw, ly)
            }
        }

        val standCx = x + w / 2
        g2.color = Color(60, 60, 66)
        g2.fill(
            Path2D.Float().apply {
                moveTo((standCx - 3).toFloat(), (y + h).toFloat())
                lineTo((standCx + 3).toFloat(), (y + h).toFloat())
                lineTo((standCx + 6).toFloat(), (y + h + 10).toFloat())
                lineTo((standCx - 6).toFloat(), (y + h + 10).toFloat())
                closePath()
            },
        )
        g2.color = Color(68, 68, 74)
        g2.fill(RoundRectangle2D.Float((standCx - 14).toFloat(), (y + h + 9).toFloat(), 28f, 3f, 2f, 2f))
    }

    private fun drawAnimatedArc(g2: Graphics2D, x1: Int, y1: Int, x2: Int, y2: Int, cx: Int, topY: Int) {
        val ctrlY = topY.toFloat()
        val cp1x = (x1 + (cx - x1) * 0.35f)
        val cp2x = (cx + (x2 - cx) * 0.65f)

        val curve = CubicCurve2D.Float(
            x1.toFloat(), y1.toFloat(), cp1x, ctrlY, cp2x, ctrlY, x2.toFloat(), y2.toFloat(),
        )

        g2.color = Color(accentBlue.red, accentBlue.green, accentBlue.blue, 20)
        g2.stroke = BasicStroke(1.5f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND, 10f, floatArrayOf(4f, 7f), 0f)
        g2.draw(curve)

        val numDots = 6
        for (i in 0 until numDots) {
            val t = ((animPhase + i.toDouble() / numDots) % 1.0).toFloat()
            val px = bezier(x1.toFloat(), cp1x, cp2x, x2.toFloat(), t)
            val py = bezier(y1.toFloat(), ctrlY, ctrlY, y2.toFloat(), t)

            val centerDist = 1f - Math.abs(t - 0.5f) * 2f
            val baseAlpha = (160 * (0.3f + centerDist * 0.7f)).toInt().coerceIn(30, 160)
            val size = 2f + centerDist * 2.5f

            g2.color = Color(accentBlue.red, accentBlue.green, accentBlue.blue, baseAlpha / 4)
            g2.fill(Ellipse2D.Float(px - size * 2f, py - size * 2f, size * 4f, size * 4f))

            g2.color = Color(accentBlue.red, accentBlue.green, accentBlue.blue, baseAlpha)
            g2.fill(Ellipse2D.Float(px - size / 2f, py - size / 2f, size, size))

            g2.color = Color(255, 255, 255, baseAlpha / 2)
            g2.fill(Ellipse2D.Float(px - size / 4f, py - size / 4f, size / 2f, size / 2f))
        }
    }

    private fun bezier(p0: Float, p1: Float, p2: Float, p3: Float, t: Float): Float {
        val u = 1f - t
        return u * u * u * p0 + 3f * u * u * t * p1 + 3f * u * t * t * p2 + t * t * t * p3
    }

    private fun drawUserInfo(g2: Graphics2D, cx: Int, topY: Int) {
        g2.color = accentBlue
        g2.fill(Ellipse2D.Float((cx - 20).toFloat(), topY.toFloat(), 40f, 40f))
        g2.color = Color(accentBlue.red / 2, accentBlue.green / 2, (accentBlue.blue * 0.8).toInt(), 80)
        g2.stroke = BasicStroke(1.5f)
        g2.draw(Ellipse2D.Float((cx - 22).toFloat(), (topY - 2).toFloat(), 44f, 44f))

        g2.color = Color(255, 255, 255, 230)
        g2.fill(Ellipse2D.Float((cx - 6).toFloat(), (topY + 8).toFloat(), 12f, 12f))
        g2.fill(Arc2D.Float((cx - 11).toFloat(), (topY + 21).toFloat(), 22f, 16f, 0f, 180f, Arc2D.PIE))

        var textY = topY + 56
        g2.color = primaryText
        g2.font = g2.font.deriveFont(Font.BOLD, 14f)
        val nfm = g2.fontMetrics
        g2.drawString(userName, cx - nfm.stringWidth(userName) / 2, textY)

        textY += 18
        g2.color = mutedText
        g2.font = g2.font.deriveFont(Font.PLAIN, 11f)
        val efm = g2.fontMetrics
        g2.drawString(userEmail, cx - efm.stringWidth(userEmail) / 2, textY)

        textY += 20
        val planColor = when (userPlan) {
            "PRO" -> accentBlue
            "ENTERPRISE" -> Color(175, 82, 222)
            else -> mutedText
        }
        g2.font = g2.font.deriveFont(Font.BOLD, 9f)
        val pfm = g2.fontMetrics
        val bw = pfm.stringWidth(userPlan) + 16
        val bh = pfm.height + 6
        val bx = cx - bw / 2
        val by = textY - pfm.ascent - 3

        g2.color = Color(planColor.red, planColor.green, planColor.blue, 25)
        g2.fill(RoundRectangle2D.Float(bx.toFloat(), by.toFloat(), bw.toFloat(), bh.toFloat(), 8f, 8f))
        g2.color = Color(planColor.red, planColor.green, planColor.blue, 50)
        g2.stroke = BasicStroke(0.8f)
        g2.draw(RoundRectangle2D.Float(bx.toFloat(), by.toFloat(), bw.toFloat(), bh.toFloat(), 8f, 8f))
        g2.color = planColor
        g2.drawString(userPlan, cx - pfm.stringWidth(userPlan) / 2, textY)
    }
}
