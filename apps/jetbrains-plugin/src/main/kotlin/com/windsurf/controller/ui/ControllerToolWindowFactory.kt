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
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.openapi.wm.ex.ToolWindowManagerListener
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.content.ContentFactory
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import com.windsurf.controller.services.AgentOutputMonitor
import com.windsurf.controller.services.CommandRelayService
import com.windsurf.controller.services.IdeIntegrationService
import com.windsurf.controller.services.PairingService
import com.windsurf.controller.services.RecentSessionsApi
import com.windsurf.controller.services.SettingsService
import com.windsurf.controller.services.TerminalOpsService
import com.windsurf.controller.services.FileOpsService
import com.windsurf.controller.services.ProjectOpsService
import com.windsurf.controller.services.buildCloudFallbackMessage
import com.windsurf.controller.util.BuildInstallCommand
import com.windsurf.controller.services.strategies.AgentInvocation
import com.windsurf.controller.services.strategies.AgentStrategyRegistry
import com.windsurf.controller.services.strategies.CopilotChatMetadataBridge
import com.windsurf.controller.services.withAuthHeaders
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.RequestBody.Companion.toRequestBody
import java.awt.*
import java.awt.event.KeyEvent
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
        // A11y: when the tool window is first opened, land focus on
        // the primary action (Generate Code / Disconnect depending
        // on pairing state) so keyboard-only users start on the
        // active control instead of the scroll pane.
        SwingUtilities.invokeLater { panel.focusPrimaryAction() }

        // Auto-show pairing code while the tool window is visible
        // + not paired — eliminates the "click Generate Code"
        // friction step. The first show fires here; subsequent
        // toggles go through the message bus listener below. Code
        // is rendered behind a "Click to reveal" button so an idle
        // panel doesn't leak a scannable QR onto a screen share.
        SwingUtilities.invokeLater { panel.onToolWindowVisibilityChanged(true) }

        // Parent the subscription to the project so it tears down on
        // project close. The ToolWindow id is captured via the
        // outer scope; we look it up by id each time because
        // ToolWindowManagerListener fires `stateChanged` for ALL
        // tool windows in the project, not just ours.
        project.messageBus.connect(project)
            .subscribe(ToolWindowManagerListener.TOPIC, object : ToolWindowManagerListener {
                override fun stateChanged(toolWindowManager: ToolWindowManager) {
                    val target = toolWindowManager.getToolWindow(toolWindow.id) ?: return
                    panel.onToolWindowVisibilityChanged(target.isVisible)
                }
            })
    }

    private class ControllerPanel(private val project: Project) : JPanel(), PairingService.PairingListener, CommandRelayService.CommandListener {

        private val logger = com.intellij.openapi.diagnostic.Logger.getInstance(ControllerPanel::class.java)
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
        // Sits in place of the QR + code when the panel auto-generated
        // the pairing code (vs the user clicking Generate explicitly).
        // Click → revealSecret() swaps it for the real QR / digits.
        // This is the JetBrains equivalent of the VS Code webview's
        // CSS blur — Swing's lack of cheap filter-blur makes the
        // "hidden behind a button" treatment the pragmatic call.
        private val revealButton = JButton("👁  Click to reveal pairing code")
        private val recentSessionsCard = RoundedPanel(12, cardBg)

        /** Drives the auto-show pairing flow: when the tool window
         *  is visible and the user isn't paired, we keep a fresh
         *  pairing code waiting under the reveal button. Cleared on
         *  pair, when the tool window goes hidden, or when the panel
         *  is disposed. Refresh ~30 s before TTL expiry so the QR is
         *  always usable while the user is looking at it. */
        private var autoPairingActive: Boolean = false
        private var pairingRefreshTimer: Timer? = null
        private var secretRevealed: Boolean = false

        // FooterStatusStrip — sits at the bottom of the tool window
        // and mirrors the mobile app's surface (state · agents · age).
        // Reads from the existing CommandRelayService + cachedAgents
        // — no new wire calls.
        private val footerDot = JPanel()
        private val footerStateLabel = JBLabel("Offline")
        private val footerAgentsLabel = JBLabel("0 agents")
        private val footerSyncLabel = JBLabel("never")
        private var footerTickTimer: java.util.Timer? = null
        // Detector runs are expensive (plugin scan + EDT tool-window
        // probe). Cache the count + refresh only on pair / agent
        // events so the 1 Hz footer tick stays O(1).
        @Volatile
        private var cachedAgentCount: Int = 0

        private val sessionRowFactory by lazy {
            SessionRowFactory(
                accentGreen = accentGreen,
                mutedText = mutedText,
                primaryText = primaryText,
                parentForDialogs = this,
                onReconnect = ::reconnectToSession,
                onDelete = ::deleteSessionFromApi,
            )
        }

        init {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = JBUI.Borders.empty(16)

            add(buildStatusCard())
            add(Box.createVerticalStrut(12))
            add(buildPairingCard())
            add(Box.createVerticalStrut(12))
            add(buildRecentSessionsCard())
            add(Box.createVerticalGlue())
            add(Box.createVerticalStrut(10))
            add(buildFooterStrip())

            PairingService.getInstance().addListener(this)
            CommandRelayService.getInstance().addListener(this)
            // Drive the status-dot color from the relay's three-state
            // signal so SSE drop → polling fallback paints the dot
            // amber instead of leaving it green and lying about
            // reachability.
            CommandRelayService.getInstance().onConnectionChange {
                SwingUtilities.invokeLater {
                    refreshStatus()
                    refreshFooter()
                }
            }
            refreshStatus()
            showPairingIdle()
            refreshRecentSessions()
            refreshFooter()
            startFooterTicker()
            // Seed the footer agent count off-EDT so the strip doesn't
            // sit on "0 agents" until the next pair / refresh.
            Thread {
                cachedAgentCount = IdeIntegrationService.getInstance().detectInstalledAgents().size
                SwingUtilities.invokeLater { refreshFooter() }
            }.start()
        }

        /**
         * Once-a-second tick that repaints the footer "Last sync"
         * age. The underlying timestamp only changes when the relay
         * gets a fresh frame, but the rendered "3s ago" string has
         * to keep climbing on every UI tick. Cheap — no I/O.
         */
        private fun startFooterTicker() {
            footerTickTimer?.cancel()
            footerTickTimer = java.util.Timer("codeagent-footer-tick", true).apply {
                scheduleAtFixedRate(object : java.util.TimerTask() {
                    override fun run() {
                        SwingUtilities.invokeLater { refreshFooter() }
                    }
                }, 1000L, 1000L)
            }
        }

        /**
         * Focus the primary action for the current pairing state:
         * `Disconnect` when an active session exists, otherwise the
         * pairing CTA (`Generate Code`). Called by the factory once
         * the tool window content is mounted so keyboard-only users
         * land on the active control.
         */
        fun focusPrimaryAction() {
            val target = if (disconnectButton.isEnabled) disconnectButton else pairButton
            target.requestFocusInWindow()
        }

        override fun onPaired(sessionId: String) {
            stopAutoPairing()
            val relay = CommandRelayService.getInstance()
            relay.startPolling()
            Thread {
                relay.reportAgents()
                // Capture the same agent list reportAgents just sent
                // so the footer strip reads the live count without a
                // second detection run.
                cachedAgentCount = IdeIntegrationService.getInstance().detectInstalledAgents().size
                SwingUtilities.invokeLater { refreshFooter() }
            }.start()
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
                    accessibleContext.accessibleName = "Connection status"
                    accessibleContext.accessibleDescription =
                        "Live connection state. Updates when the mobile relay reconnects, drops, or goes offline."
                })
            }

            disconnectButton.apply {
                font = font.deriveFont(11f)
                isEnabled = false
                // Keep the focus ring visible — IntelliJ paints a
                // theme-aware accent border when isFocusPainted is on,
                // which a11y users rely on to navigate via Tab.
                isFocusPainted = true
                putClientProperty("JButton.buttonType", "roundRect")
                mnemonic = KeyEvent.VK_D
                toolTipText = "Disconnect the paired mobile device (Alt+D)"
                accessibleContext.accessibleName = "Disconnect the paired mobile device"
                accessibleContext.accessibleDescription =
                    "Ends the current paired session and stops the relay."
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
                accessibleContext.accessibleName = "Pairing QR code"
                accessibleContext.accessibleDescription =
                    "Scan this QR code with the CodeAgent Mobile app to pair."
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
                accessibleContext.accessibleName = "Pairing code"
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
                isFocusPainted = true
                putClientProperty("JButton.buttonType", "roundRect")
                mnemonic = KeyEvent.VK_C
                toolTipText = "Generate a new pairing code (Alt+C)"
                accessibleContext.accessibleName = "Generate Pairing Code"
                accessibleContext.accessibleDescription =
                    "Generates a six-character code to pair a new mobile device."
            }
            pairButton.addActionListener { onPairClicked() }

            revealButton.apply {
                alignmentX = Component.CENTER_ALIGNMENT
                font = BrandFonts.jetBrainsMono(Font.PLAIN, 11f)
                foreground = primaryText
                background = BrandColors.glowPurple
                isFocusPainted = true
                isContentAreaFilled = true
                isOpaque = true
                isVisible = false
                putClientProperty("JButton.buttonType", "roundRect")
                toolTipText = "Reveal the pairing code (kept hidden so it doesn't leak on a screen share)"
                accessibleContext.accessibleName = "Reveal pairing code"
                accessibleContext.accessibleDescription =
                    "Show the QR and six-character code so they can be entered on a mobile device."
            }
            revealButton.addActionListener { revealSecret() }

            pairingCard.add(titleLabel)
            pairingCard.add(Box.createVerticalStrut(16))
            pairingCard.add(qrLabel)
            pairingCard.add(Box.createVerticalStrut(10))
            pairingCard.add(codeLabel)
            pairingCard.add(Box.createVerticalStrut(6))
            pairingCard.add(codeSeparator)
            pairingCard.add(revealButton)
            pairingCard.add(Box.createVerticalStrut(16))
            pairingCard.add(pairButton)

            pairingCard.maximumSize = Dimension(Int.MAX_VALUE, 400)
            pairingCard.alignmentX = Component.LEFT_ALIGNMENT
            return pairingCard
        }

        private fun buildFooterStrip(): JComponent {
            val strip = JPanel(FlowLayout(FlowLayout.LEFT, 8, 0)).apply {
                isOpaque = true
                background = cardBg
                border = BorderFactory.createCompoundBorder(
                    BorderFactory.createMatteBorder(1, 0, 0, 0, if (isDark) Color(46, 46, 51) else Color(220, 220, 224)),
                    EmptyBorder(6, 12, 6, 12),
                )
                maximumSize = Dimension(Int.MAX_VALUE, 28)
                alignmentX = Component.LEFT_ALIGNMENT
                accessibleContext.accessibleName = "Connection summary"
                accessibleContext.accessibleDescription =
                    "Live status row: connection state, detected agent count, and last sync age."
            }

            footerDot.apply {
                preferredSize = Dimension(7, 7)
                maximumSize = Dimension(7, 7)
                isOpaque = false
            }
            footerStateLabel.apply {
                font = BrandFonts.hanken(Font.PLAIN, 11f)
                foreground = primaryText
            }
            footerAgentsLabel.apply {
                font = BrandFonts.hanken(Font.PLAIN, 11f)
                foreground = mutedText
            }
            footerSyncLabel.apply {
                font = BrandFonts.jetBrainsMono(Font.PLAIN, 11f)
                foreground = mutedText
            }

            strip.add(footerDot)
            strip.add(footerStateLabel)
            strip.add(JBLabel("·").apply { foreground = mutedText })
            strip.add(footerAgentsLabel)
            strip.add(JBLabel("·").apply { foreground = mutedText })
            strip.add(footerSyncLabel)
            return strip
        }

        private fun refreshFooter() {
            val relay = CommandRelayService.getInstance()
            val polling = relay.isPolling
            val cs = if (polling) relay.getConnectionState() else CommandRelayService.ConnectionState.OFFLINE
            val (dotColor, label) = when (cs) {
                CommandRelayService.ConnectionState.ONLINE -> accentGreen to "Connected"
                CommandRelayService.ConnectionState.RECONNECTING -> BrandColors.warningAmber to "Reconnecting"
                CommandRelayService.ConnectionState.OFFLINE -> accentRed to "Offline"
            }
            footerDot.background = dotColor
            footerDot.repaint()
            footerStateLabel.text = label

            // Agent count comes from the panel's cached count (refreshed
            // on pair / refreshAgents). The 1 Hz footer tick must stay
            // O(1) — invoking detectInstalledAgents() here would re-run
            // the full registry every second.
            val agentCount = cachedAgentCount
            footerAgentsLabel.text = if (agentCount == 1) "1 agent" else "$agentCount agents"

            footerSyncLabel.text = formatSyncAge(relay.getLastSuccessfulSyncMs())
        }

        private fun formatSyncAge(lastSyncMs: Long?): String {
            if (lastSyncMs == null) return "never"
            val ageSec = ((System.currentTimeMillis() - lastSyncMs) / 1000).coerceAtLeast(0)
            if (ageSec < 60) return "${ageSec}s ago"
            val ageMin = ageSec / 60
            if (ageMin < 60) return "${ageMin}m ago"
            val ageHr = ageMin / 60
            return "${ageHr}h ago"
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
                val emptyLabel = JBLabel(BrandMessages.EmptyRecentSessions).apply {
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
                    isFocusPainted = true
                    putClientProperty("JButton.buttonType", "roundRect")
                    cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                    mnemonic = KeyEvent.VK_H
                    toolTipText = "Open codeagent-mobile.com in your browser (Alt+H)"
                    accessibleContext.accessibleName = "Visit Homepage"
                    accessibleContext.accessibleDescription =
                        "Opens codeagent-mobile.com in the system browser."
                    addActionListener {
                        try {
                            java.awt.Desktop.getDesktop().browse(java.net.URI("https://www.codeagent-mobile.com"))
                        } catch (e: Exception) { logger.trace(e) }
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
                    val row = sessionRowFactory.build(session, isCurrentlyConnected)
                    recentSessionsCard.add(row)
                    recentSessionsCard.add(Box.createVerticalStrut(6))
                }
            }

            recentSessionsCard.revalidate()
            recentSessionsCard.repaint()
        }

        private fun reconnectToSession(session: SettingsService.RecentSession) {
            val pairing = PairingService.getInstance()
            // Restore session info on the pairing service
            pairing.clearCurrentSession()
            // Re-pair by calling the reconnect API endpoint. The
            // callback runs on the OkHttp worker — hop to EDT before
            // touching Swing.
            RecentSessionsApi.reconnect(session) { result ->
                SwingUtilities.invokeLater {
                    when (result) {
                        is RecentSessionsApi.ReconnectResult.Success -> {
                            pairing.onReconnected(result.sessionId, result.userInfo)
                        }
                        RecentSessionsApi.ReconnectResult.SessionExpired -> {
                            JOptionPane.showMessageDialog(
                                this@ControllerPanel,
                                "Session expired. Please generate a new code.",
                                "Reconnect Failed",
                                JOptionPane.WARNING_MESSAGE,
                            )
                        }
                        RecentSessionsApi.ReconnectResult.Failed -> {
                            JOptionPane.showMessageDialog(
                                this@ControllerPanel,
                                "Failed to reconnect. Session may have expired.",
                                "Reconnect Failed",
                                JOptionPane.WARNING_MESSAGE,
                            )
                        }
                        is RecentSessionsApi.ReconnectResult.Error -> {
                            JOptionPane.showMessageDialog(
                                this@ControllerPanel,
                                "Connection error: ${result.message}",
                                "Reconnect Error",
                                JOptionPane.ERROR_MESSAGE,
                            )
                        }
                    }
                }
            }
        }

        private fun deleteSessionFromApi(session: SettingsService.RecentSession) {
            RecentSessionsApi.deleteSession(
                session,
                onDeleted = { SwingUtilities.invokeLater { refreshRecentSessions() } },
                onError = { msg ->
                    SwingUtilities.invokeLater {
                        JOptionPane.showMessageDialog(
                            this@ControllerPanel,
                            "Failed to delete session: $msg",
                            "Delete Error",
                            JOptionPane.ERROR_MESSAGE,
                        )
                    }
                },
            )
        }

        private fun generateQrImage(text: String, size: Int): BufferedImage =
            QrImageRenderer.render(text, size, isDark)

        private fun showPairingIdle() {
            qrLabel.isVisible = false
            codeLabel.isVisible = false
            codeSeparator.isVisible = false
            revealButton.isVisible = false
            pairButton.text = "Generate Code"
        }

        /** Swap the QR + code visibility against the reveal button.
         *  Manual generate → reveal button hidden, QR/code shown.
         *  Auto generate   → reveal button shown over a hidden
         *                    QR/code (still rendered in memory, just
         *                    not laid out — so the click → reveal
         *                    flip is instant). */
        private fun applySecretVisibility() {
            val showSecret = secretRevealed
            qrLabel.isVisible = showSecret
            codeLabel.isVisible = showSecret
            codeSeparator.isVisible = showSecret
            revealButton.isVisible = !showSecret
            pairingCard.revalidate()
            pairingCard.repaint()
        }

        private fun revealSecret() {
            secretRevealed = true
            applySecretVisibility()
        }

        /** Kick off the auto-pair loop: render a fresh code under the
         *  reveal button + schedule the next refresh before TTL
         *  expiry. Idempotent — no-op if already running or already
         *  paired. */
        private fun triggerAutoPairing() {
            if (autoPairingActive) return
            if (PairingService.getInstance().currentSessionId != null) return
            autoPairingActive = true
            secretRevealed = false
            generatePairingCode(autoMode = true)
        }

        private fun stopAutoPairing() {
            autoPairingActive = false
            pairingRefreshTimer?.stop()
            pairingRefreshTimer = null
        }

        /** Shared code-fetch path. `autoMode=true` keeps the new code
         *  hidden behind the reveal button (privacy default); `false`
         *  shows it immediately (the user explicitly clicked
         *  Generate / Refresh). */
        private fun generatePairingCode(autoMode: Boolean) {
            pairButton.isEnabled = false
            pairButton.text = "Generating..."
            // Don't touch visibility yet — let the result handler set
            // it once the code (and reveal button) are populated.

            // Network call must run off the EDT; dispatch result back on EDT.
            Thread {
                val result = PairingService.getInstance().requestPairingCode()
                when (result) {
                    is PairingService.PairingCodeResult.Code -> {
                        SwingUtilities.invokeLater {
                            pairButton.text = "Refresh Code"

                            val spaced = result.code.take(3) + " " + result.code.drop(3)
                            codeLabel.text = spaced

                            try {
                                val qrImage = generateQrImage(result.code, 160)
                                qrLabel.icon = ImageIcon(qrImage)
                            } catch (e: Exception) { logger.trace(e) }

                            if (!autoMode) {
                                secretRevealed = true
                            }
                            applySecretVisibility()

                            // Schedule the next refresh ~30 s before expiry
                            // while the auto loop is active. Clamp the delay
                            // so a misconfigured short TTL can't pin us into
                            // a tight loop.
                            pairingRefreshTimer?.stop()
                            if (autoPairingActive) {
                                val delay = maxOf(15_000L, result.expiresAt - System.currentTimeMillis() - 30_000L)
                                pairingRefreshTimer = Timer(delay.toInt()) {
                                    if (autoPairingActive) {
                                        secretRevealed = false
                                        generatePairingCode(autoMode = true)
                                    }
                                }.apply { isRepeats = false; start() }
                            }
                            pairButton.isEnabled = true
                        }
                    }
                    PairingService.PairingCodeResult.Blocked -> {
                        if (!autoMode) {
                            // Explicit "Generate Code" click — show the cloud-fallback
                            // panel so the user understands the network block and has a
                            // clear recovery path (parity with VS Code primary button).
                            // Git/network exec runs HERE on the background thread — NOT
                            // inside invokeLater — to keep the EDT free.
                            val ops = ProjectOpsService.getInstance()
                            val repo = ops.detectRepoSlug()
                            val branch: String? = run {
                                val status = ops.gitStatus()
                                status.get("branch")?.takeIf { !it.isJsonNull }?.asString?.takeIf { it != "(detached)" }
                            }
                            val message = buildCloudFallbackMessage(repo, branch)
                            SwingUtilities.invokeLater {
                                pairButton.isEnabled = true
                                showPairingIdle()
                                CloudFallbackDialog(message, onRetry = {
                                    generatePairingCode(autoMode = false)
                                }).show()
                            }
                        } else {
                            // API unreachable during auto-pairing loop — do NOT show
                            // the cloud-fallback panel on auto-refresh (only on explicit
                            // user action). Retry silently later.
                            SwingUtilities.invokeLater {
                                showPairingIdle()
                                pairingRefreshTimer?.stop()
                                pairingRefreshTimer = Timer(10_000) {
                                    if (autoPairingActive) generatePairingCode(autoMode = true)
                                }.apply { isRepeats = false; start() }
                                pairButton.isEnabled = true
                            }
                        }
                    }
                    PairingService.PairingCodeResult.None -> {
                        SwingUtilities.invokeLater {
                            showPairingIdle()
                            if (!autoMode) {
                                JOptionPane.showMessageDialog(
                                    this,
                                    "Failed to generate code. Check API settings.",
                                    "Pairing Error",
                                    JOptionPane.ERROR_MESSAGE
                                )
                            } else {
                                // Auto loop failure — try again in 10 s.
                                pairingRefreshTimer?.stop()
                                pairingRefreshTimer = Timer(10_000) {
                                    if (autoPairingActive) generatePairingCode(autoMode = true)
                                }.apply { isRepeats = false; start() }
                            }
                            pairButton.isEnabled = true
                        }
                    }
                }
            }.apply { isDaemon = true; start() }
        }

        /** Called by `ControllerToolWindowFactory` when the tool
         *  window is shown / hidden so the auto-pair loop only burns
         *  cycles while the panel is actually on screen. */
        fun onToolWindowVisibilityChanged(visible: Boolean) {
            if (visible) {
                triggerAutoPairing()
            } else {
                stopAutoPairing()
            }
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
                    isFocusPainted = true
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
                    mnemonic = KeyEvent.VK_U
                    toolTipText = "Open the upgrade page in your browser (Alt+U)"
                    accessibleContext.accessibleName = "Upgrade to Pro"
                    accessibleContext.accessibleDescription =
                        "Opens the subscription upgrade page in the system browser."
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
                    } catch (e: Exception) { logger.trace(e) }
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
            } catch (e: Exception) { logger.trace(e) }
        }

        private fun onPairClicked() {
            // User clicked Generate / Refresh — surface the code
            // immediately (no reveal step). The shared path then
            // also arms the auto-refresh loop so the code stays
            // current without another click.
            secretRevealed = true
            generatePairingCode(autoMode = false)
            // Promote to "auto" semantics so the timer keeps it
            // fresh — the explicit click counts as the user being
            // present and wanting a usable code.
            autoPairingActive = true
        }

        private fun onDisconnectClicked() {
            // Tell the backend to drop the session before we clear local
            // state — fires `paired_session_removed` on the SSE bus so
            // the mobile app's device card disappears immediately
            // instead of waiting for offline detection to kick in.
            val sessionId = PairingService.getInstance().currentSessionId
            if (sessionId != null) {
                RecentSessionsApi.unpairAsync(sessionId)
                SettingsService.getInstance().removeRecentSession(sessionId)
            }
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

            // Restore pairing card and auto-generate a new QR code,
            // hidden behind the reveal button so a user disconnecting
            // mid-screen-share doesn't expose the next code.
            restorePairingCard()
            refreshRecentSessions()

            triggerAutoPairing()
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
            pairingCard.add(revealButton)
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

