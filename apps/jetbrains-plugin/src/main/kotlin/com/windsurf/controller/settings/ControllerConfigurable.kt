package com.windsurf.controller.settings

import com.intellij.openapi.options.Configurable
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import com.windsurf.controller.services.SettingsService
import java.awt.event.KeyEvent
import javax.swing.JComponent
import javax.swing.JPanel

class ControllerConfigurable : Configurable {

    private var apiUrlField: JBTextField? = null
    private var autoConnectCheckbox: JBCheckBox? = null
    private var notificationsCheckbox: JBCheckBox? = null
    private var mainPanel: JPanel? = null

    override fun getDisplayName(): String = "CodeAgent Mobile"

    /**
     * Returns the control that should receive focus when the
     * settings page first opens. IntelliJ honours this so keyboard
     * users land on the most-edited field (API base URL) instead of
     * the dialog's OK button.
     */
    override fun getPreferredFocusedComponent(): JComponent? = apiUrlField

    override fun createComponent(): JComponent {
        val settings = SettingsService.getInstance().state

        apiUrlField = JBTextField(settings.apiBaseUrl).apply {
            accessibleContext.accessibleName = "API Base URL"
            accessibleContext.accessibleDescription =
                "Backend host the plugin talks to. Change only when running against staging."
        }
        autoConnectCheckbox = JBCheckBox("Auto-connect on startup", settings.autoConnect).apply {
            mnemonic = KeyEvent.VK_A
            accessibleContext.accessibleDescription =
                "When enabled, the plugin reconnects to the last paired session on IDE startup."
        }
        notificationsCheckbox = JBCheckBox("Show notifications", settings.showNotifications).apply {
            mnemonic = KeyEvent.VK_N
            accessibleContext.accessibleDescription =
                "When enabled, prompt-received / sent toasts surface in the IDE."
        }

        val pluginIdField = JBTextField(SettingsService.getInstance().ensurePluginId()).apply {
            isEditable = false
            accessibleContext.accessibleName = "Plugin ID (read-only)"
            accessibleContext.accessibleDescription =
                "Stable identifier this IDE reports to the backend; shown for diagnostics."
        }

        mainPanel = FormBuilder.createFormBuilder()
            .addLabeledComponent(JBLabel("API Base URL:"), apiUrlField!!, 1, false)
            .addComponent(autoConnectCheckbox!!, 1)
            .addComponent(notificationsCheckbox!!, 1)
            .addLabeledComponent(JBLabel("Plugin ID:"), pluginIdField, 1, false)
            .addComponentFillVertically(JPanel(), 0)
            .panel

        return mainPanel!!
    }

    override fun isModified(): Boolean {
        val settings = SettingsService.getInstance().state
        return apiUrlField?.text != settings.apiBaseUrl ||
                autoConnectCheckbox?.isSelected != settings.autoConnect ||
                notificationsCheckbox?.isSelected != settings.showNotifications
    }

    override fun apply() {
        val settings = SettingsService.getInstance()
        settings.state.apiBaseUrl = apiUrlField?.text ?: settings.state.apiBaseUrl
        settings.state.autoConnect = autoConnectCheckbox?.isSelected ?: settings.state.autoConnect
        settings.state.showNotifications = notificationsCheckbox?.isSelected ?: settings.state.showNotifications
    }

    override fun reset() {
        val settings = SettingsService.getInstance().state
        apiUrlField?.text = settings.apiBaseUrl
        autoConnectCheckbox?.isSelected = settings.autoConnect
        notificationsCheckbox?.isSelected = settings.showNotifications
    }
}
