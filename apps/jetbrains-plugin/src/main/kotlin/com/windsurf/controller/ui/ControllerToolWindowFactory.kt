package com.windsurf.controller.ui

import com.google.gson.JsonObject
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.content.ContentFactory
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import com.windsurf.controller.services.AgentOutputMonitor
import com.windsurf.controller.services.CommandRelayService
import com.windsurf.controller.services.IdeIntegrationService
import com.windsurf.controller.services.PairingService
import com.windsurf.controller.services.SettingsService
import com.windsurf.controller.services.TerminalAgentService
import com.windsurf.controller.services.TerminalOpsService
import com.windsurf.controller.services.McpConfigWriterService
import com.windsurf.controller.services.McpConfigureRequest
import com.windsurf.controller.services.McpEntry
import com.windsurf.controller.services.FileOpsService
import com.windsurf.controller.services.ProjectOpsService
import com.windsurf.controller.services.McpServerDef
import com.windsurf.controller.util.BuildInstallCommand
import com.windsurf.controller.services.strategies.AgentInvocation
import com.windsurf.controller.services.strategies.AgentStrategyRegistry
import com.windsurf.controller.services.strategies.CopilotChatMetadataBridge
import com.windsurf.controller.services.withAuthHeaders
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

    private class ControllerPanel(private val project: Project) : JPanel(), PairingService.PairingListener, CommandRelayService.CommandListener {

        private val router = RemoteCommandRouter(project)

        private val isDark = !UIUtil.isUnderIntelliJLaF()
        // Brand palette sourced from BrandColors. Field names match
        // their semantic role; the literal RGB lives one file over so
        // a future palette tweak doesn't have to touch this 1500-line
        // factory.
        private val cardBg = if (isDark) BrandColors.surfaceGray else BrandColors.surfaceLight
        private val accentGreen = BrandColors.successGreen
        private val accentRed = BrandColors.errorRed
        private val accentBlue = BrandColors.electricPurple
        private val mutedText = if (isDark) BrandColors.mutedText else Color(108, 108, 112)
        private val primaryText = if (isDark) BrandColors.onSurface else Color(0, 0, 0)

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

            PairingService.getInstance().addListener(this)
            CommandRelayService.getInstance().addListener(this)
            // Drive the status-dot color from the relay's three-state
            // signal so SSE drop → polling fallback paints the dot
            // amber instead of leaving it green and lying about
            // reachability.
            CommandRelayService.getInstance().onConnectionChange {
                SwingUtilities.invokeLater { refreshStatus() }
            }
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
                    // Status label uses Hanken Grotesk per DLS — mixed
                    // case ("Connected", "Reconnecting…", "Offline").
                    font = BrandFonts.hanken(Font.BOLD, 13f)
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
                // Brand font for the pairing code — JetBrains Mono with
                // electric-purple foreground mirrors the mobile DLS
                // pairing-code surface. Falls back to system Monospaced
                // if the TTF can't be loaded.
                font = BrandFonts.jetBrainsMono(Font.BOLD, 28f)
                foreground = BrandColors.electricPurple
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
                    // Treat the active paired session as "connected" only
                    // when the relay is actively polling; the WebSocket
                    // transport this used to read is gone.
                    val isCurrentlyConnected = session.sessionId == currentSid &&
                        CommandRelayService.getInstance().isPolling
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
                        .withAuthHeaders()
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
                            // Persist the freshly-replayed plugin auth
                            // token so post-reconnect calls (e.g. the
                            // mint-cli-token flow that drives Claude
                            // Code auto-pair) have it available.
                            // Sessions paired before plugin v2.x never
                            // had the token persisted; reconnect is
                            // their upgrade path.
                            val refreshedAuthToken = dataObj?.get("pluginAuthToken")
                                ?.takeIf { !it.isJsonNull }?.asString
                            if (!refreshedAuthToken.isNullOrEmpty()) {
                                settings.setPluginAuthToken(refreshedAuthToken)
                            }
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
                        .withAuthHeaders()
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
            // Single source of truth now: the relay's three-state
            // connectionState. The legacy WebSocket transport is gone.
            val relay = CommandRelayService.getInstance()
            val connected = relay.isPolling
            val state = if (connected) relay.getConnectionState() else null
            statusLabel.text = when {
                !connected -> "Disconnected"
                state == CommandRelayService.ConnectionState.RECONNECTING -> "Reconnecting…"
                state == CommandRelayService.ConnectionState.OFFLINE -> "Offline"
                else -> "Connected"
            }
            val color = when {
                !connected -> accentRed
                state == CommandRelayService.ConnectionState.RECONNECTING -> BrandColors.warningAmber
                state == CommandRelayService.ConnectionState.OFFLINE -> accentRed
                else -> accentGreen
            }
            statusLabel.foreground = color
            statusDot.background = color
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

        override fun onCommandReceived(command: CommandRelayService.RemoteCommand) {
            router.dispatch(command)
        }
    }
}

