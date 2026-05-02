package com.windsurf.controller.ui

import com.google.gson.JsonObject
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.content.ContentFactory
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import com.windsurf.controller.services.AgentBridgeService
import com.windsurf.controller.services.AgentOutputMonitor
import com.windsurf.controller.services.CommandRelayService
import com.windsurf.controller.services.IdeIntegrationService
import com.windsurf.controller.services.PairingService
import com.windsurf.controller.services.SettingsService
import com.windsurf.controller.services.TerminalAgentService
import com.windsurf.controller.services.McpConfigWriterService
import com.windsurf.controller.services.McpConfigureRequest
import com.windsurf.controller.services.McpEntry
import com.windsurf.controller.services.FileOpsService
import com.windsurf.controller.services.McpServerDef
import com.windsurf.controller.services.WebSocketService
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.RequestBody.Companion.toRequestBody
import java.awt.*
import java.awt.geom.*
import java.awt.image.BufferedImage
import javax.swing.*
import javax.swing.border.EmptyBorder

class ControllerToolWindowFactory : ToolWindowFactory {

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        IdeIntegrationService.getInstance().setProject(project)
        val panel = ControllerPanel(project)
        val scrollPane = JBScrollPane(panel).apply {
            border = BorderFactory.createEmptyBorder()
            horizontalScrollBarPolicy = ScrollPaneConstants.HORIZONTAL_SCROLLBAR_NEVER
        }
        val content = ContentFactory.getInstance().createContent(scrollPane, "", false)
        toolWindow.contentManager.addContent(content)
    }

    private class RoundedPanel(
        private val cornerRadius: Int = 12,
        private val bgColor: Color? = null
    ) : JPanel() {
        init {
            isOpaque = false
        }

        override fun paintComponent(g: Graphics) {
            val g2 = g.create() as Graphics2D
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            val fill = bgColor ?: background
            g2.color = fill
            g2.fill(RoundRectangle2D.Float(0f, 0f, width.toFloat(), height.toFloat(), cornerRadius.toFloat(), cornerRadius.toFloat()))
            g2.dispose()
            super.paintComponent(g)
        }
    }

    private class DeviceConnectionPanel(
        private val accentBlue: Color,
        private val accentGreen: Color,
        private val mutedText: Color,
        private val primaryText: Color,
        private val userName: String,
        private val userEmail: String,
        private val userPlan: String
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
                Color(accentBlue.red, accentBlue.green, accentBlue.blue, 35)
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
            g2.fill(Path2D.Float().apply {
                moveTo((standCx - 3).toFloat(), (y + h).toFloat())
                lineTo((standCx + 3).toFloat(), (y + h).toFloat())
                lineTo((standCx + 6).toFloat(), (y + h + 10).toFloat())
                lineTo((standCx - 6).toFloat(), (y + h + 10).toFloat())
                closePath()
            })
            g2.color = Color(68, 68, 74)
            g2.fill(RoundRectangle2D.Float((standCx - 14).toFloat(), (y + h + 9).toFloat(), 28f, 3f, 2f, 2f))
        }

        private fun drawAnimatedArc(g2: Graphics2D, x1: Int, y1: Int, x2: Int, y2: Int, cx: Int, topY: Int) {
            val ctrlY = topY.toFloat()
            val cp1x = (x1 + (cx - x1) * 0.35f)
            val cp2x = (cx + (x2 - cx) * 0.65f)

            val curve = CubicCurve2D.Float(
                x1.toFloat(), y1.toFloat(), cp1x, ctrlY, cp2x, ctrlY, x2.toFloat(), y2.toFloat()
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

    private class ControllerPanel(private val project: Project) : JPanel(), WebSocketService.WebSocketListener, PairingService.PairingListener, CommandRelayService.CommandListener {

        private val isDark = !UIUtil.isUnderIntelliJLaF()
        private val cardBg = if (isDark) Color(45, 45, 48) else Color(245, 245, 247)
        private val accentGreen = Color(52, 199, 89)
        private val accentRed = Color(255, 69, 58)
        private val accentBlue = Color(0, 122, 255)
        private val mutedText = if (isDark) Color(142, 142, 147) else Color(108, 108, 112)
        private val primaryText = if (isDark) Color(255, 255, 255) else Color(0, 0, 0)

        private val statusDot = JPanel()
        private val statusLabel = JBLabel("Disconnected")
        private val pairButton = JButton("Generate Code")
        private val disconnectButton = JButton("Disconnect")
        private val qrLabel = JLabel()
        private val codeLabel = JBLabel("")
        private val pairingCard = RoundedPanel(12, cardBg)
        private val codeSeparator = JBLabel("Scan QR or enter code in your mobile app")
        private val recentSessionsCard = RoundedPanel(12, cardBg)

        init {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = JBUI.Borders.empty(16)

            add(buildStatusCard())
            add(Box.createVerticalStrut(12))
            add(buildPairingCard())
            add(Box.createVerticalStrut(12))
            add(buildRecentSessionsCard())
            add(Box.createVerticalGlue())

            WebSocketService.getInstance().addListener(this)
            PairingService.getInstance().addListener(this)
            CommandRelayService.getInstance().addListener(this)
            refreshStatus()
            showPairingIdle()
            refreshRecentSessions()
        }

        override fun onPaired(sessionId: String) {
            val relay = CommandRelayService.getInstance()
            relay.startPolling()
            Thread { relay.reportAgents() }.start()
            SwingUtilities.invokeLater {
                statusLabel.text = "Connected"
                statusLabel.foreground = accentGreen
                statusDot.background = accentGreen
                statusDot.repaint()
                disconnectButton.isEnabled = true
                showPairedUserInfo()
                refreshRecentSessions()
            }
        }

        override fun onCommandReceived(command: CommandRelayService.RemoteCommand) {
            SwingUtilities.invokeLater {
                val agent = AgentBridgeService.getInstance()
                val relay = CommandRelayService.getInstance()
                val ide = IdeIntegrationService.getInstance()

                val outputMonitor = AgentOutputMonitor.getInstance()

                when (command.type) {
                    "start_task" -> {
                        val prompt = command.payload.get("prompt")?.asString ?: ""
                        val agentId = command.payload.get("agentId")?.asString
                        agent.startTask(prompt)
                        val sent = ide.sendPromptToAgent(prompt, agentId)
                        relay.sendResult(command.id, "completed", com.google.gson.JsonObject().apply {
                            addProperty("message", "Task started: $prompt")
                        })
                        if (sent) {
                            val targetAgent = if (agentId != null) {
                                ide.detectInstalledAgents().find { it.id == agentId }
                            } else {
                                ide.detectInstalledAgents().firstOrNull()
                            }
                            val twId = targetAgent?.toolWindowId ?: ""
                            if (twId.startsWith("__terminal__:")) {
                                val terminalMonitor = TerminalAgentService.getInstance()
                                terminalMonitor.startMonitoring(command.sessionId, prompt)
                            } else if (twId.isNotEmpty()) {
                                outputMonitor.startMonitoring(command.sessionId, twId, prompt)
                            }
                        }
                    }
                    "stop_task" -> {
                        outputMonitor.stopMonitoring()
                        TerminalAgentService.getInstance().stopMonitoring()
                        agent.stopCurrentTask()
                        relay.sendResult(command.id, "completed", com.google.gson.JsonObject().apply {
                            addProperty("message", "Task stopped")
                        })
                    }
                    "approve_action" -> {
                        agent.approveCurrentAction()
                        relay.sendResult(command.id, "completed", com.google.gson.JsonObject().apply {
                            addProperty("message", "Action approved")
                        })
                    }
                    "reject_action" -> {
                        agent.rejectCurrentAction()
                        relay.sendResult(command.id, "completed", com.google.gson.JsonObject().apply {
                            addProperty("message", "Action rejected")
                        })
                    }
                    "provide_input" -> {
                        val input = command.payload.get("input")?.asString ?: ""
                        agent.provideInput(input)
                        ide.sendPromptToIde(input)
                        relay.sendResult(command.id, "completed", com.google.gson.JsonObject().apply {
                            addProperty("message", "Input provided")
                        })
                    }
                    "mcp_configure" -> {
                        handleMcpConfigure(command, relay)
                    }
                    "mcp_status" -> {
                        handleMcpStatus(command, relay)
                    }
                    "read_file" -> {
                        val filePath = command.payload.get("path")?.asString
                        if (filePath.isNullOrEmpty()) {
                            relay.sendResult(command.id, "failed", com.google.gson.JsonObject().apply {
                                addProperty("error", "Missing path")
                            })
                        } else {
                            val res = FileOpsService.getInstance().readFile(filePath)
                            relay.sendResult(command.id, "completed", res)
                        }
                    }
                    "write_file" -> {
                        val filePath = command.payload.get("path")?.asString
                        val contentEl = command.payload.get("content")
                        if (filePath.isNullOrEmpty() || contentEl == null || contentEl.isJsonNull) {
                            relay.sendResult(command.id, "failed", com.google.gson.JsonObject().apply {
                                addProperty("error", "Missing path or content")
                            })
                        } else {
                            val res = FileOpsService.getInstance().writeFile(filePath, contentEl.asString)
                            relay.sendResult(command.id, "completed", res)
                        }
                    }
                    else -> {
                        relay.sendResult(command.id, "failed", com.google.gson.JsonObject().apply {
                            addProperty("error", "Unknown command type: ${command.type}")
                        })
                    }
                }
            }
        }

        private fun handleMcpConfigure(
            command: CommandRelayService.RemoteCommand,
            relay: CommandRelayService
        ) {
            try {
                val payload = command.payload
                val scope = payload.get("scope")?.asString ?: "global"
                val mcpsArray = payload.getAsJsonArray("mcps") ?: com.google.gson.JsonArray()
                val targetAgentsArray = payload.getAsJsonArray("targetAgents")

                val mcps = mcpsArray.map { element ->
                    val obj = element.asJsonObject
                    val serverObj = obj.getAsJsonObject("server")
                    val envObj = obj.getAsJsonObject("env") ?: com.google.gson.JsonObject()
                    McpEntry(
                        id = obj.get("id").asString,
                        server = McpServerDef(
                            command = serverObj.get("command").asString,
                            args = serverObj.getAsJsonArray("args").map { it.asString }
                        ),
                        env = envObj.entrySet().associate { it.key to it.value.asString }
                    )
                }

                val targetAgents = targetAgentsArray?.map { it.asString }

                val request = McpConfigureRequest(
                    scope = scope,
                    mcps = mcps,
                    targetAgents = targetAgents
                )

                val writer = McpConfigWriterService.getInstance()
                val results = writer.configure(request)

                val resultsArray = com.google.gson.JsonArray()
                for (r in results) {
                    resultsArray.add(com.google.gson.JsonObject().apply {
                        addProperty("agent", r.agent)
                        addProperty("file", r.file)
                        addProperty("status", r.status)
                        if (r.error != null) addProperty("error", r.error)
                    })
                }

                relay.sendResult(command.id, "completed", com.google.gson.JsonObject().apply {
                    addProperty("message", "MCP configuration written for ${results.count { it.status == "written" }} agents")
                    add("results", resultsArray)
                })
            } catch (e: Exception) {
                relay.sendResult(command.id, "failed", com.google.gson.JsonObject().apply {
                    addProperty("error", "MCP configuration failed: ${e.message}")
                })
            }
        }

        private fun handleMcpStatus(
            command: CommandRelayService.RemoteCommand,
            relay: CommandRelayService
        ) {
            try {
                val writer = McpConfigWriterService.getInstance()
                val configured = writer.getConfiguredMcps()

                val allMcpIds = mutableSetOf<String>()
                val agentsArray = com.google.gson.JsonArray()

                for (info in configured) {
                    allMcpIds.addAll(info.mcpIds)
                    agentsArray.add(com.google.gson.JsonObject().apply {
                        addProperty("agent", info.agent)
                        addProperty("configFile", info.configFile)
                        val idsArr = com.google.gson.JsonArray()
                        info.mcpIds.forEach { idsArr.add(it) }
                        add("mcpIds", idsArr)
                    })
                }

                val allIdsArray = com.google.gson.JsonArray()
                allMcpIds.forEach { allIdsArray.add(it) }

                relay.sendResult(command.id, "completed", com.google.gson.JsonObject().apply {
                    add("configuredMcpIds", allIdsArray)
                    add("agents", agentsArray)
                })
            } catch (e: Exception) {
                relay.sendResult(command.id, "failed", com.google.gson.JsonObject().apply {
                    addProperty("error", "Failed to read MCP status: ${e.message}")
                })
            }
        }

        private fun buildStatusCard(): JComponent {
            val card = RoundedPanel(12, cardBg).apply {
                layout = BorderLayout()
                border = EmptyBorder(14, 16, 14, 16)
            }

            val leftPanel = JPanel(FlowLayout(FlowLayout.LEFT, 0, 0)).apply {
                isOpaque = false
                statusDot.apply {
                    preferredSize = Dimension(10, 10)
                    maximumSize = Dimension(10, 10)
                    isOpaque = false
                }
                add(statusDot)
                add(Box.createHorizontalStrut(8))
                add(statusLabel.apply {
                    font = font.deriveFont(Font.BOLD, 13f)
                    foreground = primaryText
                })
            }

            disconnectButton.apply {
                font = font.deriveFont(11f)
                isEnabled = false
                isFocusPainted = false
                putClientProperty("JButton.buttonType", "roundRect")
            }

            card.add(leftPanel, BorderLayout.WEST)
            card.add(disconnectButton, BorderLayout.EAST)
            disconnectButton.addActionListener { onDisconnectClicked() }

            card.maximumSize = Dimension(Int.MAX_VALUE, 50)
            card.alignmentX = Component.LEFT_ALIGNMENT
            return card
        }

        private fun buildPairingCard(): JComponent {
            pairingCard.apply {
                layout = BoxLayout(this, BoxLayout.Y_AXIS)
                border = EmptyBorder(20, 20, 20, 20)
            }

            val titleLabel = JBLabel("Pair with Mobile").apply {
                font = font.deriveFont(Font.BOLD, 14f)
                foreground = primaryText
                alignmentX = Component.CENTER_ALIGNMENT
            }

            qrLabel.apply {
                horizontalAlignment = SwingConstants.CENTER
                alignmentX = Component.CENTER_ALIGNMENT
                isVisible = false
            }

            codeLabel.apply {
                font = Font("Monospaced", Font.BOLD, 28)
                foreground = primaryText
                horizontalAlignment = SwingConstants.CENTER
                alignmentX = Component.CENTER_ALIGNMENT
                isVisible = false
            }

            codeSeparator.apply {
                font = font.deriveFont(11f)
                foreground = mutedText
                horizontalAlignment = SwingConstants.CENTER
                alignmentX = Component.CENTER_ALIGNMENT
                isVisible = false
            }

            pairButton.apply {
                alignmentX = Component.CENTER_ALIGNMENT
                font = font.deriveFont(Font.BOLD, 13f)
                isFocusPainted = false
                putClientProperty("JButton.buttonType", "roundRect")
            }
            pairButton.addActionListener { onPairClicked() }

            pairingCard.add(titleLabel)
            pairingCard.add(Box.createVerticalStrut(16))
            pairingCard.add(qrLabel)
            pairingCard.add(Box.createVerticalStrut(10))
            pairingCard.add(codeLabel)
            pairingCard.add(Box.createVerticalStrut(6))
            pairingCard.add(codeSeparator)
            pairingCard.add(Box.createVerticalStrut(16))
            pairingCard.add(pairButton)

            pairingCard.maximumSize = Dimension(Int.MAX_VALUE, 400)
            pairingCard.alignmentX = Component.LEFT_ALIGNMENT
            return pairingCard
        }

        private fun buildRecentSessionsCard(): JComponent {
            recentSessionsCard.apply {
                layout = BoxLayout(this, BoxLayout.Y_AXIS)
                border = EmptyBorder(14, 16, 14, 16)
            }
            recentSessionsCard.maximumSize = Dimension(Int.MAX_VALUE, 400)
            recentSessionsCard.alignmentX = Component.LEFT_ALIGNMENT
            return recentSessionsCard
        }

        private fun refreshRecentSessions() {
            recentSessionsCard.removeAll()

            val sessions = SettingsService.getInstance().getRecentSessions()

            val titleLabel = JBLabel("Recent Sessions").apply {
                font = font.deriveFont(Font.BOLD, 14f)
                foreground = primaryText
                alignmentX = Component.LEFT_ALIGNMENT
            }
            recentSessionsCard.add(titleLabel)
            recentSessionsCard.add(Box.createVerticalStrut(10))

            if (sessions.isEmpty()) {
                val emptyLabel = JBLabel("No recent sessions").apply {
                    font = font.deriveFont(11f)
                    foreground = mutedText
                    alignmentX = Component.LEFT_ALIGNMENT
                }
                recentSessionsCard.add(emptyLabel)
                recentSessionsCard.add(Box.createVerticalStrut(12))

                val onboardingPanel = JPanel().apply {
                    layout = BoxLayout(this, BoxLayout.Y_AXIS)
                    isOpaque = false
                    alignmentX = Component.LEFT_ALIGNMENT
                }

                val instructionLabel = JBLabel("<html><body style='width:220px'>" +
                    "To get started, you need the <b>CodeAgent Mobile</b> companion app:" +
                    "<br/><br/>" +
                    "\u2022 <b>Mobile App</b> — Download from the App Store or Play Store<br/>" +
                    "\u2022 <b>Web Dashboard</b> — Use the browser at <b>codeagent-mobile.com/dashboard</b>" +
                    "<br/><br/>" +
                    "Then generate a pairing code above and enter it in the app." +
                    "</body></html>").apply {
                    font = font.deriveFont(11f)
                    foreground = mutedText
                    alignmentX = Component.LEFT_ALIGNMENT
                }
                onboardingPanel.add(instructionLabel)
                onboardingPanel.add(Box.createVerticalStrut(10))

                val homepageBtn = JButton("Visit Homepage").apply {
                    alignmentX = Component.LEFT_ALIGNMENT
                    font = font.deriveFont(Font.BOLD, 11f)
                    isFocusPainted = false
                    putClientProperty("JButton.buttonType", "roundRect")
                    cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                    addActionListener {
                        try {
                            java.awt.Desktop.getDesktop().browse(java.net.URI("https://www.codeagent-mobile.com"))
                        } catch (_: Exception) { }
                    }
                }
                onboardingPanel.add(homepageBtn)

                recentSessionsCard.add(onboardingPanel)
            } else {
                val currentSid = PairingService.getInstance().currentSessionId
                for (session in sessions) {
                    val isCurrentlyConnected = session.sessionId == currentSid &&
                        WebSocketService.getInstance().isConnected
                    val row = buildSessionRow(session, isCurrentlyConnected)
                    recentSessionsCard.add(row)
                    recentSessionsCard.add(Box.createVerticalStrut(6))
                }
            }

            recentSessionsCard.revalidate()
            recentSessionsCard.repaint()
        }

        private fun buildSessionRow(
            session: SettingsService.RecentSession,
            isCurrentlyConnected: Boolean
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
                    reconnectToSession(session)
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
                    this@ControllerPanel,
                    "Delete this session? This action cannot be undone.",
                    "Delete Session",
                    JOptionPane.OK_CANCEL_OPTION,
                    JOptionPane.WARNING_MESSAGE
                )
                if (confirm == JOptionPane.OK_OPTION) {
                    deleteSessionFromApi(session)
                }
            }
            actionsPanel.add(deleteBtn)

            row.add(actionsPanel, BorderLayout.EAST)

            return row
        }

        private fun reconnectToSession(session: SettingsService.RecentSession) {
            val pairing = PairingService.getInstance()
            val settings = SettingsService.getInstance()

            // Restore session info on the pairing service
            pairing.clearCurrentSession()

            // Re-pair by calling the reconnect API endpoint
            Thread {
                try {
                    val pluginId = settings.ensurePluginId()
                    val body = JsonObject().apply {
                        addProperty("pluginId", pluginId)
                        addProperty("sessionId", session.sessionId)
                    }
                    val httpClient = OkHttpClient.Builder()
                        .connectTimeout(10, java.util.concurrent.TimeUnit.SECONDS)
                        .readTimeout(10, java.util.concurrent.TimeUnit.SECONDS)
                        .build()
                    val request = okhttp3.Request.Builder()
                        .url("${settings.state.apiBaseUrl}/api/pairing/reconnect")
                        .post(com.google.gson.Gson().toJson(body)
                            .toRequestBody("application/json".toMediaType()))
                        .build()
                    val response = httpClient.newCall(request).execute()
                    val responseBody = response.body?.string()

                    if (response.isSuccessful && responseBody != null) {
                        val json = com.google.gson.Gson().fromJson(responseBody, JsonObject::class.java)
                        val success = json.get("success")?.asBoolean ?: false
                        if (success) {
                            val dataObj = json.getAsJsonObject("data")
                            val userObj = dataObj?.getAsJsonObject("user")
                            val plan = userObj?.get("plan")?.asString ?: session.userPlan
                            val periodEnd = userObj?.get("currentPeriodEnd")?.takeIf { !it.isJsonNull }?.asString
                            SwingUtilities.invokeLater {
                                // Trigger pairing flow as if newly paired
                                pairing.onReconnected(
                                    session.sessionId,
                                    PairingService.PairedUserInfo(
                                        name = session.userName,
                                        email = session.userEmail,
                                        plan = plan,
                                        currentPeriodEnd = periodEnd
                                    )
                                )
                            }
                        } else {
                            SwingUtilities.invokeLater {
                                JOptionPane.showMessageDialog(
                                    this@ControllerPanel,
                                    "Session expired. Please generate a new code.",
                                    "Reconnect Failed",
                                    JOptionPane.WARNING_MESSAGE
                                )
                            }
                        }
                    } else {
                        SwingUtilities.invokeLater {
                            JOptionPane.showMessageDialog(
                                this@ControllerPanel,
                                "Failed to reconnect. Session may have expired.",
                                "Reconnect Failed",
                                JOptionPane.WARNING_MESSAGE
                            )
                        }
                    }
                } catch (e: Exception) {
                    SwingUtilities.invokeLater {
                        JOptionPane.showMessageDialog(
                            this@ControllerPanel,
                            "Connection error: ${e.message}",
                            "Reconnect Error",
                            JOptionPane.ERROR_MESSAGE
                        )
                    }
                }
            }.start()
        }

        private fun deleteSessionFromApi(session: SettingsService.RecentSession) {
            val settings = SettingsService.getInstance()
            Thread {
                try {
                    val httpClient = OkHttpClient.Builder()
                        .connectTimeout(10, java.util.concurrent.TimeUnit.SECONDS)
                        .readTimeout(10, java.util.concurrent.TimeUnit.SECONDS)
                        .build()
                    val request = okhttp3.Request.Builder()
                        .url("${settings.state.apiBaseUrl}/api/pairing/sessions/${session.sessionId}")
                        .delete()
                        .build()
                    val response = httpClient.newCall(request).execute()
                    response.close()

                    settings.removeRecentSession(session.sessionId)
                    SwingUtilities.invokeLater { refreshRecentSessions() }
                } catch (e: Exception) {
                    SwingUtilities.invokeLater {
                        JOptionPane.showMessageDialog(
                            this@ControllerPanel,
                            "Failed to delete session: ${e.message}",
                            "Delete Error",
                            JOptionPane.ERROR_MESSAGE
                        )
                    }
                }
            }.start()
        }

        private fun generateQrImage(text: String, size: Int): BufferedImage {
            val hints = mapOf(
                EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M,
                EncodeHintType.MARGIN to 1
            )
            val writer = QRCodeWriter()
            val bitMatrix = writer.encode(text, BarcodeFormat.QR_CODE, size, size, hints)
            val bg = if (isDark) Color(60, 60, 63) else Color.WHITE
            val fg = if (isDark) Color.WHITE else Color.BLACK
            val image = BufferedImage(size, size, BufferedImage.TYPE_INT_RGB)
            for (x in 0 until size) {
                for (y in 0 until size) {
                    image.setRGB(x, y, if (bitMatrix.get(x, y)) fg.rgb else bg.rgb)
                }
            }
            return image
        }

        private fun showPairingIdle() {
            qrLabel.isVisible = false
            codeLabel.isVisible = false
            codeSeparator.isVisible = false
            pairButton.text = "Generate Code"
        }

        private fun showPairedUserInfo() {
            val user = PairingService.getInstance().pairedUser
            qrLabel.isVisible = false
            codeLabel.isVisible = false

            pairingCard.removeAll()

            val connectionPanel = DeviceConnectionPanel(
                accentBlue = accentBlue,
                accentGreen = accentGreen,
                mutedText = mutedText,
                primaryText = primaryText,
                userName = user?.name ?: "Unknown",
                userEmail = user?.email ?: "",
                userPlan = user?.plan ?: "FREE"
            ).apply {
                alignmentX = Component.CENTER_ALIGNMENT
            }

            pairingCard.add(connectionPanel)

            // Subscription info section
            val plan = user?.plan ?: "FREE"
            val subPanel = JPanel().apply {
                layout = BoxLayout(this, BoxLayout.Y_AXIS)
                isOpaque = false
                border = JBUI.Borders.empty(4, 16, 12, 16)
                alignmentX = Component.CENTER_ALIGNMENT
            }

            if (plan == "FREE") {
                // FREE user: show upgrade button
                val upgradeBtn = JButton("Upgrade to Pro").apply {
                    alignmentX = Component.CENTER_ALIGNMENT
                    isFocusPainted = false
                    isContentAreaFilled = false
                    isOpaque = true
                    background = accentBlue
                    foreground = Color.WHITE
                    font = font.deriveFont(Font.BOLD, 12f)
                    border = BorderFactory.createCompoundBorder(
                        BorderFactory.createLineBorder(Color(accentBlue.red, accentBlue.green, accentBlue.blue, 120), 1, true),
                        JBUI.Borders.empty(6, 20)
                    )
                    cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                    maximumSize = Dimension(Int.MAX_VALUE, 34)
                    addActionListener { openSubscriptionPage() }
                }
                subPanel.add(upgradeBtn)
            } else {
                // PRO/ENTERPRISE: show billing period end
                val periodEnd = user?.currentPeriodEnd
                if (periodEnd != null) {
                    try {
                        val instant = java.time.Instant.parse(periodEnd)
                        val localDate = instant.atZone(java.time.ZoneId.systemDefault()).toLocalDate()
                        val formatted = localDate.format(java.time.format.DateTimeFormatter.ofPattern("MMM dd, yyyy"))
                        val billingLabel = JBLabel("Next billing: $formatted").apply {
                            alignmentX = Component.CENTER_ALIGNMENT
                            foreground = mutedText
                            font = font.deriveFont(Font.PLAIN, 11f)
                        }
                        subPanel.add(billingLabel)
                    } catch (_: Exception) { }
                }
            }

            pairingCard.add(subPanel)

            pairingCard.revalidate()
            pairingCard.repaint()
        }

        private fun openSubscriptionPage() {
            val apiUrl = SettingsService.getInstance().state.apiBaseUrl.trimEnd('/')
            val webUrl = apiUrl.replace("-api", "-web").replace("/api", "")
            val settingsUrl = "$webUrl/app/settings"
            try {
                java.awt.Desktop.getDesktop().browse(java.net.URI(settingsUrl))
            } catch (_: Exception) { }
        }

        private fun onPairClicked() {
            pairButton.isEnabled = false
            pairButton.text = "Generating..."
            qrLabel.isVisible = false
            codeLabel.isVisible = false
            codeSeparator.isVisible = false

            SwingUtilities.invokeLater {
                val result = PairingService.getInstance().requestPairingCode()
                if (result != null) {
                    pairButton.text = "Refresh Code"

                    val spaced = result.code.take(3) + " " + result.code.drop(3)
                    codeLabel.text = spaced
                    codeLabel.isVisible = true
                    codeSeparator.isVisible = true

                    try {
                        val qrImage = generateQrImage(result.code, 160)
                        qrLabel.icon = ImageIcon(qrImage)
                        qrLabel.isVisible = true
                    } catch (_: Exception) { }

                    pairingCard.revalidate()
                    pairingCard.repaint()

                    Timer(300_000) {
                        SwingUtilities.invokeLater { showPairingIdle() }
                    }.apply { isRepeats = false; start() }
                } else {
                    showPairingIdle()
                    JOptionPane.showMessageDialog(
                        this,
                        "Failed to generate code. Check API settings.",
                        "Pairing Error",
                        JOptionPane.ERROR_MESSAGE
                    )
                }
                pairButton.isEnabled = true
            }
        }

        private fun onDisconnectClicked() {
            WebSocketService.getInstance().disconnect()
            val relay = CommandRelayService.getInstance()
            relay.stopPolling()
            relay.reportOffline()
            PairingService.getInstance().stopPolling()
            PairingService.getInstance().clearCurrentSession()
            statusLabel.text = "Disconnected"
            statusLabel.foreground = accentRed
            statusDot.background = accentRed
            statusDot.repaint()
            disconnectButton.isEnabled = false

            // Restore pairing card and auto-generate a new QR code
            restorePairingCard()
            refreshRecentSessions()

            // Auto-generate new QR code so the plugin is ready for a new device
            onPairClicked()
        }

        private fun restorePairingCard() {
            pairingCard.removeAll()

            val titleLabel = JBLabel("Pair with Mobile").apply {
                font = font.deriveFont(Font.BOLD, 14f)
                foreground = primaryText
                alignmentX = Component.CENTER_ALIGNMENT
            }

            pairingCard.add(titleLabel)
            pairingCard.add(Box.createVerticalStrut(16))
            pairingCard.add(qrLabel)
            pairingCard.add(Box.createVerticalStrut(10))
            pairingCard.add(codeLabel)
            pairingCard.add(Box.createVerticalStrut(6))
            pairingCard.add(codeSeparator)
            pairingCard.add(Box.createVerticalStrut(16))
            pairingCard.add(pairButton)

            showPairingIdle()
            pairButton.isEnabled = true
            pairingCard.revalidate()
            pairingCard.repaint()
        }

        private fun refreshStatus() {
            val ws = WebSocketService.getInstance()

            val connected = ws.isConnected
            statusLabel.text = if (connected) "Connected" else "Disconnected"
            statusLabel.foreground = if (connected) accentGreen else accentRed
            statusDot.background = if (connected) accentGreen else accentRed
            statusDot.repaint()
            disconnectButton.isEnabled = connected
        }

        override fun paintComponent(g: Graphics) {
            super.paintComponent(g)
            val g2 = g as Graphics2D
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            val dotBounds = statusDot.bounds
            if (dotBounds.width > 0) {
                val parent = statusDot.parent ?: return
                val loc = SwingUtilities.convertPoint(parent, dotBounds.location, this)
                g2.color = statusDot.background
                g2.fillOval(loc.x, loc.y, dotBounds.width, dotBounds.height)
            }
        }

        override fun onConnected() = SwingUtilities.invokeLater { refreshStatus() }
        override fun onDisconnected(reason: String) = SwingUtilities.invokeLater { refreshStatus() }
        override fun onMessage(type: String, payload: JsonObject) = SwingUtilities.invokeLater { refreshStatus() }
        override fun onError(error: String) = SwingUtilities.invokeLater { refreshStatus() }
    }
}
