package com.windsurf.controller.settings

import com.intellij.openapi.options.Configurable
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import com.windsurf.controller.services.SettingsService
import javax.swing.JComponent
import javax.swing.JPanel

class ControllerConfigurable : Configurable {

    private var apiUrlField: JBTextField? = null
    private var autoConnectCheckbox: JBCheckBox? = null
    private var notificationsCheckbox: JBCheckBox? = null
    private var mainPanel: JPanel? = null

    override fun getDisplayName(): String = "Windsurf Mobile Controller"

    override fun createComponent(): JComponent {
        val settings = SettingsService.getInstance().state

        apiUrlField = JBTextField(settings.apiBaseUrl)
        autoConnectCheckbox = JBCheckBox("Auto-connect on startup", settings.autoConnect)
        notificationsCheckbox = JBCheckBox("Show notifications", settings.showNotifications)

        mainPanel = FormBuilder.createFormBuilder()
            .addLabeledComponent(JBLabel("API Base URL:"), apiUrlField!!, 1, false)
            .addComponent(autoConnectCheckbox!!, 1)
            .addComponent(notificationsCheckbox!!, 1)
            .addLabeledComponent(
                JBLabel("Plugin ID:"),
                JBTextField(SettingsService.getInstance().ensurePluginId()).apply { isEditable = false },
                1,
                false
            )
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
