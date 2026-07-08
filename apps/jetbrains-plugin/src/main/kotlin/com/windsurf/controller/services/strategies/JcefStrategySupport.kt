package com.windsurf.controller.services.strategies

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.wm.ToolWindow
import com.intellij.util.concurrency.AppExecutorUtil
import com.windsurf.controller.services.IdeIntegrationService
import java.awt.Component
import java.awt.Container
import java.awt.datatransfer.StringSelection
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Shared building block for strategies whose chat is rendered inside a
 * JCEF browser (Windsurf/Codeium, JetBrains PR AI Assistant, every
 * generic Swing+JCEF panel). It is **not** a base class — each
 * strategy decides whether to use this and what to do on failure.
 * The point of having it as a free function is that the JCEF input
 * discovery is generic (textarea / ProseMirror / contenteditable) and
 * not tied to any one vendor's chat — there's no agent-specific code
 * here, so reusing it across these three strategies doesn't recreate
 * the shared-dispatcher antipattern.
 *
 * Returns `true` if the prompt was either injected via JCEF or the
 * Robot fallback was scheduled. `false` only when the tool window
 * itself could not be activated.
 */
internal fun deliverPromptViaJcef(
    invocation: AgentInvocation,
    notificationTitle: String,
    notFoundMessage: String,
    logger: Logger,
): Boolean {
    val ide = IdeIntegrationService.getInstance()
    val agents = ide.detectInstalledAgents()
    val app = ApplicationManager.getApplication()

    val twRef = AtomicReference<ToolWindow?>(null)
    val jcefRef = AtomicReference<Any?>(null)
    val activateTask = Runnable {
        val tw = ide.findToolWindow(invocation.project, invocation.agent, agents) ?: return@Runnable
        tw.show()
        tw.activate(null)
        twRef.set(tw)
        for (content in tw.contentManager.contents) {
            val browser = ide.findJBCefBrowser(content.component)
            if (browser != null) {
                jcefRef.set(browser)
                break
            }
        }
    }
    if (app.isDispatchThread) activateTask.run() else try {
        app.invokeAndWait(activateTask)
    } catch (e: Exception) {
        logger.warn("invokeAndWait for activation failed: ${e.message}")
    }

    if (twRef.get() == null) {
        CopyPasteManager.getInstance().setContents(StringSelection(invocation.prompt))
        ide.showNotification(notFoundMessage, invocation.prompt)
        return false
    }

    val browser = jcefRef.get()
    if (browser != null) {
        if (ide.executeJcefPromptInjection(browser, invocation.prompt)) {
            ide.showNotification(notificationTitle, invocation.prompt)
            return true
        }
        logger.warn("JCEF JS injection failed, falling back to Robot paste")
    }

    // Identity with pre-refactor behaviour: clipboard + Robot Cmd+V on
    // whatever has focus.
    CopyPasteManager.getInstance().setContents(StringSelection(invocation.prompt))
    // Delay off-EDT, then hop back — a Thread.sleep inside
    // invokeLater would block the Swing EDT (painting + input)
    // for the whole 800 ms.
    AppExecutorUtil.getAppScheduledExecutorService().schedule({
        app.invokeLater { ide.simulatePasteAndSubmit() }
    }, 800, TimeUnit.MILLISECONDS)
    ide.showNotification(notificationTitle, invocation.prompt)
    return true
}
