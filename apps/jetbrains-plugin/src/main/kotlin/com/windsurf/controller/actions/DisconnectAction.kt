package com.windsurf.controller.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.ui.Messages
import com.windsurf.controller.services.CommandRelayService
import com.windsurf.controller.services.PairingService
import com.windsurf.controller.ui.BrandMessages

/**
 * Stops the relay and clears the paired session — backs the
 * "Disconnect Mobile" entry under Tools → CodeAgent Mobile. Backing
 * surface used to be the legacy WebSocketService transport; now we
 * drive the same wind-down the panel button uses: relay.stopPolling
 * + PairingService.clearCurrentSession.
 */
class DisconnectAction : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val relay = CommandRelayService.getInstance()
        if (relay.isPolling) {
            relay.reportOffline()
            relay.stopPolling()
            PairingService.getInstance().clearCurrentSession()
            Messages.showInfoMessage(
                e.project,
                BrandMessages.Disconnected,
                "Disconnected"
            )
        } else {
            Messages.showInfoMessage(
                e.project,
                "No mobile device is currently connected.",
                "Not Connected"
            )
        }
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = CommandRelayService.getInstance().isPolling
    }
}
