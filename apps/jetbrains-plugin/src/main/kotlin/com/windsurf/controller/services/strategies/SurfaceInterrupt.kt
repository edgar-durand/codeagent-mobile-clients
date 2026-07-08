package com.windsurf.controller.services.strategies

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.windsurf.controller.services.DetectedAgent
import com.windsurf.controller.services.IdeIntegrationService
import java.awt.event.KeyEvent
import javax.swing.SwingUtilities

/**
 * Best-effort mid-generation interrupt for GUI-injected agents. The
 * concrete strategies hold no persistent surface handle, so we re-resolve
 * the tool window at stop time. JCEF agents get a "stop generating" click
 * via injected JS; Swing agents get an Escape keystroke. Never throws.
 */
object SurfaceInterrupt {
    private val logger = Logger.getInstance(SurfaceInterrupt::class.java)

    // Common stop affordances across Copilot / JetBrains AI / Windsurf JCEF UIs.
    private const val STOP_JS = """
        (function () {
          const sel = [
            '[aria-label*="Stop" i]', '[aria-label*="Cancel" i]',
            'button[title*="Stop" i]', 'button[title*="Cancel" i]',
            '[data-testid*="stop" i]', '.stop-generating', '.codicon-debug-stop'
          ];
          for (const s of sel) {
            const el = document.querySelector(s);
            if (el) { el.click(); return true; }
          }
          return false;
        })();
    """

    fun interrupt(
        ide: IdeIntegrationService,
        project: Project,
        agent: DetectedAgent?,
        agents: List<DetectedAgent>,
    ): Boolean {
        return try {
            val tw = ide.findToolWindow(project, agent, agents) ?: return false
            var handled = false
            val task = Runnable {
                // (a) JCEF path — run the stop-click JS in any browser we find.
                for (content in tw.contentManager.contents) {
                    val browser = ide.findJBCefBrowser(content.component)
                    if (browser != null) {
                        if (ide.executeJcefScript(browser, STOP_JS)) handled = true
                    }
                }
                // (b) Swing fallback — Escape into the chat input.
                if (!handled) {
                    val input = detectSwingChatTarget(tw)?.input
                    if (input != null) {
                        val esc = KeyEvent(
                            input, KeyEvent.KEY_PRESSED, System.currentTimeMillis(),
                            0, KeyEvent.VK_ESCAPE, KeyEvent.CHAR_UNDEFINED,
                        )
                        input.dispatchEvent(esc)
                        handled = true
                    }
                }
            }
            if (SwingUtilities.isEventDispatchThread()) task.run()
            else SwingUtilities.invokeAndWait(task)
            handled
        } catch (e: Throwable) {
            logger.trace(e)
            false
        }
    }
}
