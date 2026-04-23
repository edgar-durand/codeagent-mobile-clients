package com.windsurf.controller.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.ui.Messages
import com.windsurf.controller.services.WebSocketService

class DisconnectAction : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val ws = WebSocketService.getInstance()
        if (ws.isConnected) {
            ws.disconnect()
            Messages.showInfoMessage(
                e.project,
                "Mobile device disconnected successfully.",
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
        e.presentation.isEnabled = WebSocketService.getInstance().isConnected
    }
}
