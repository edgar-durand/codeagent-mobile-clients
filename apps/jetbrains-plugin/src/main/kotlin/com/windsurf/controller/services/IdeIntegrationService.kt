package com.windsurf.controller.services

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowManager
import com.windsurf.controller.services.detection.AgentDetectorRegistry
import com.windsurf.controller.services.detection.DetectionContext
import com.windsurf.controller.ui.BrandMessages
import java.awt.Component
import java.awt.Container
import java.awt.datatransfer.StringSelection
import java.lang.ref.WeakReference
import kotlinx.coroutines.runBlocking

data class DetectedAgent(
    val id: String,
    val name: String,
    val pluginId: String,
    val toolWindowId: String,
    val icon: String,
    val installed: Boolean,
    val isTerminal: Boolean = false,
)

/**
 * Thin orchestrator over the agent-detection registry. The plugin's
 * job for any agent — terminal (Claude / Codex / Cursor / CodeRabbit
 * / Aider) or in-IDE chat (Copilot, Windsurf, AI Assistant, …) — is
 * the same: detect it in this IDE, report the list to the mobile,
 * and (for in-IDE chat) hand off prompts to the strategy registry.
 *
 * Per-agent detection logic lives in the
 * `com.windsurf.controller.services.detection.detectors` package.
 * This service contains no agent-specific code; everything here is
 * wiring.
 */
@Service(Service.Level.APP)
class IdeIntegrationService {

    private val logger = Logger.getInstance(IdeIntegrationService::class.java)
    private var cachedAgents: List<DetectedAgent>? = null

    /**
     * Recency-ordered list of every IDE project window the panel has
     * touched. We're an @Service.APP singleton multiplexed across
     * windows — keeping every Project here (instead of a single
     * clobbered ref, audit #99) lets `getProject()` always pick a
     * live context.
     */
    private val projectRefs = mutableListOf<WeakReference<Project>>()

    fun setProject(project: Project) {
        synchronized(projectRefs) {
            projectRefs.removeAll { it.get() == null || it.get() === project }
            projectRefs.add(0, WeakReference(project))
        }
        cachedAgents = null
    }

    /** Force the next `detectInstalledAgents()` to re-scan. */
    fun clearCache() {
        cachedAgents = null
    }

    private fun getProject(): Project? {
        synchronized(projectRefs) {
            for (ref in projectRefs) {
                val p = ref.get()
                if (p != null && !p.isDisposed) return p
            }
        }
        return ProjectManager.getInstance().openProjects.firstOrNull()
    }

    /**
     * Detect every agent visible to the mobile picker. Runs the
     * full detector registry (terminal + in-IDE + dynamic catch-all)
     * — there is no per-agent logic in this method.
     *
     * Documented blocking call. All current callers pin to a pooled
     * executor before invoking, so `runBlocking(Dispatchers.IO)` is
     * the right tool for the suspending detectors.
     */
    fun detectInstalledAgents(): List<DetectedAgent> {
        cachedAgents?.let { return it }
        val detected = runBlocking(kotlinx.coroutines.Dispatchers.IO) {
            AgentDetectorRegistry.run(
                AgentDetectorRegistry.detectors,
                DetectionContext(logger = logger, project = getProject()),
            )
        }
        cachedAgents = detected
        logger.info("Detected ${detected.size} agents: ${detected.joinToString(", ") { "${it.name}(${it.toolWindowId})" }}")
        return detected
    }

    /**
     * Send an ad-hoc prompt to a target agent. Routes through the
     * strategy registry so each agent's specific delivery path
     * (Swing for Copilot/AI Assistant, JCEF for Windsurf, generic
     * JCEF for the long tail) is honoured.
     *
     * Terminal agents (Claude / Codex / Cursor CLI / CodeRabbit /
     * Aider) are rejected here — those are owned by codeam-cli; the
     * mobile dispatches their prompts to the CLI's pluginId.
     */
    fun sendPromptToAgent(prompt: String, agentId: String? = null): Boolean {
        logger.info("Sending prompt to agent=${agentId ?: "auto"}: ${prompt.take(50)}...")
        cachedAgents = null

        val project = getProject()
        if (project == null) {
            logger.warn("No project available")
            CopyPasteManager.getInstance().setContents(StringSelection(prompt))
            showNotification(BrandMessages.promptCopiedToClipboard("no project window open"), prompt)
            return false
        }

        val agents = detectInstalledAgents()
        val targetAgent = if (agentId != null) {
            agents.find { it.id == agentId }
        } else {
            // Side-panel "send" entry — pick the first in-IDE chat
            // agent. Terminal agents are CLI-owned and shouldn't be
            // spawned from a panel input field.
            agents.firstOrNull { !it.toolWindowId.startsWith("__terminal__:") }
                ?: agents.firstOrNull()
        }

        if (targetAgent == null) {
            CopyPasteManager.getInstance().setContents(StringSelection(prompt))
            showNotification(BrandMessages.promptCopiedToClipboard("no AI agent detected"), prompt)
            return false
        }
        if (targetAgent.toolWindowId.startsWith("__terminal__:")) {
            CopyPasteManager.getInstance().setContents(StringSelection(prompt))
            showNotification(
                BrandMessages.promptCopiedToClipboard("${targetAgent.name} runs via codeam-cli"),
                prompt,
            )
            return false
        }

        val invocation = com.windsurf.controller.services.strategies.AgentInvocation(
            project = project,
            agent = targetAgent,
            prompt = prompt,
            // Ad-hoc dispatches have no `start_task` session id — strategies'
            // `deliverPrompt` paths must not consult this field.
            sessionId = "",
        )
        val sent = com.windsurf.controller.services.strategies.AgentStrategyRegistry
            .getInstance()
            .deliverPrompt(invocation)
        if (!sent) {
            CopyPasteManager.getInstance().setContents(StringSelection(prompt))
            showNotification(BrandMessages.promptCopiedToClipboard("delivery to the agent failed"), prompt)
            return false
        }
        return true
    }

    fun sendPromptToIde(prompt: String): Boolean = sendPromptToAgent(prompt, null)

    /**
     * JCEF JS prompt injection — strategies whose chat is rendered
     * in Chromium/JBCef (Windsurf, generic) call this directly. The
     * regex-based input discovery handles ProseMirror,
     * contenteditable, textarea, and `role=textbox` patterns.
     */
    fun executeJcefPromptInjection(browser: Any, prompt: String): Boolean {
        val escapedPrompt = prompt
            .replace("\\", "\\\\")
            .replace("`", "\\`")
            .replace("\$", "\\\$")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
        val js = JCEF_INJECTION_TEMPLATE.replace("__PROMPT__", escapedPrompt)
        val ok = executeJcefScript(browser, js)
        if (ok) logger.info("JCEF prompt injection executed")
        return ok
    }

    /**
     * Run an arbitrary JS snippet in a JBCef browser handle via the
     * same reflected `CefBrowser.executeJavaScript` primitive used by
     * prompt injection. Best-effort: returns `false` (never throws) if
     * the JCEF class chain or the browser handle can't be reached. Used
     * by both prompt injection and the best-effort stop-generating
     * interrupt (`SurfaceInterrupt`).
     */
    fun executeJcefScript(browser: Any, js: String): Boolean {
        return try {
            val platformCL = browser.javaClass.classLoader
            val jbCefBaseClass = Class.forName("com.intellij.ui.jcef.JBCefBrowserBase", true, platformCL)
            val cefBrowser = jbCefBaseClass.getMethod("getCefBrowser").invoke(browser) ?: return false
            val cefBrowserIface = Class.forName("org.cef.browser.CefBrowser", true, cefBrowser.javaClass.classLoader)
            val execMethod = cefBrowserIface.getMethod(
                "executeJavaScript", String::class.java, String::class.java, Int::class.javaPrimitiveType,
            )
            execMethod.invoke(cefBrowser, js, "about:blank", 0)
            true
        } catch (e: Exception) {
            logger.warn("JCEF executeJavaScript failed: ${e.message}")
            false
        }
    }

    /** Recursively walk a Swing tree looking for a JBCef browser instance. */
    fun findJBCefBrowser(component: Component): Any? {
        val className = component.javaClass.name
        if (className.contains("\$MyPanel") && className.contains("JBCef")) {
            try {
                val outerField = component.javaClass.getDeclaredField("this\$0")
                outerField.isAccessible = true
                val outer = outerField.get(component)
                if (outer != null) return outer
            } catch (e: Exception) { logger.trace(e) }
        }
        if (component is Container) {
            for (i in 0 until component.componentCount) {
                val found = findJBCefBrowser(component.getComponent(i))
                if (found != null) return found
            }
        }
        return null
    }

    /**
     * Resolve the ToolWindow for the given target agent. Strategies
     * call this when they need the live `ToolWindow` instance for
     * the agent the mobile picked. We trust the detector to have
     * already chosen a valid `toolWindowId`; if the user opened /
     * closed the window after detection, the next `Refresh Agents`
     * captures the change.
     */
    fun findToolWindow(project: Project, targetAgent: DetectedAgent?, agents: List<DetectedAgent>): ToolWindow? {
        if (targetAgent == null) return null
        val twManager = ToolWindowManager.getInstance(project)
        val direct = twManager.getToolWindow(targetAgent.toolWindowId)
        if (direct != null) return direct
        // The detector emitted a toolWindowId based on either an open
        // window or the plugin's default — if it's not registered
        // right now we don't silently substitute another vendor's
        // window (audit #98 — that's how selecting AI Assistant used
        // to activate Copilot's completion panel).
        logger.warn("Target tool window not registered: ${targetAgent.toolWindowId} (agent=${targetAgent.name})")
        return null
    }

    /**
     * Robot-driven Cmd+V (or Ctrl+V on non-Mac) followed by Enter.
     * Last-resort path used when neither Swing-direct nor JCEF
     * injection is available.
     *
     * macOS Cmd+V race: explicit `Thread.sleep` gaps between modifier
     * press and key press so the OS latches the modifier before the
     * V keystroke arrives (older code missed this and produced a
     * literal "v" instead of paste).
     */
    fun simulatePasteAndSubmit() {
        try {
            val robot = java.awt.Robot()
            robot.autoDelay = 80
            if (com.intellij.openapi.util.SystemInfo.isMac) {
                robot.keyPress(java.awt.event.KeyEvent.VK_META)
                Thread.sleep(80)
                robot.keyPress(java.awt.event.KeyEvent.VK_V)
                Thread.sleep(80)
                robot.keyRelease(java.awt.event.KeyEvent.VK_V)
                Thread.sleep(80)
                robot.keyRelease(java.awt.event.KeyEvent.VK_META)
            } else {
                robot.keyPress(java.awt.event.KeyEvent.VK_CONTROL)
                Thread.sleep(80)
                robot.keyPress(java.awt.event.KeyEvent.VK_V)
                Thread.sleep(80)
                robot.keyRelease(java.awt.event.KeyEvent.VK_V)
                Thread.sleep(80)
                robot.keyRelease(java.awt.event.KeyEvent.VK_CONTROL)
            }
            Thread.sleep(500)
            robot.keyPress(java.awt.event.KeyEvent.VK_ENTER)
            robot.keyRelease(java.awt.event.KeyEvent.VK_ENTER)
        } catch (e: Exception) {
            logger.warn("Robot simulation failed: ${e.message}")
        }
    }

    fun showNotification(title: String, content: String) {
        try {
            val project = getProject()
            NotificationGroupManager.getInstance()
                .getNotificationGroup("CodeAgent-Mobile")
                .createNotification(title, content.take(200), NotificationType.INFORMATION)
                .notify(project)
        } catch (e: Exception) {
            logger.warn("Notification failed: ${e.message}")
        }
    }

    companion object {
        fun getInstance(): IdeIntegrationService =
            ApplicationManager.getApplication().getService(IdeIntegrationService::class.java)

        /**
         * JS template that walks every common chat-input shape and
         * submits. The detector injects an escaped prompt at
         * `__PROMPT__`. Kept inline because the same shape ships in
         * VS Code's observer-bridge script; if you change one,
         * mirror the other.
         */
        private val JCEF_INJECTION_TEMPLATE = """
            (function() {
                var log = function(msg) { console.log('__CAGENT__:INJECT:' + msg); };
                var prompt = `__PROMPT__`;

                // Strategy 1: textarea (most chat inputs).
                var ta = document.querySelectorAll('textarea');
                if (ta.length > 0) {
                    var input = ta[ta.length - 1];
                    input.focus();
                    var nativeSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLTextAreaElement.prototype, 'value'
                    );
                    if (nativeSetter && nativeSetter.set) {
                        nativeSetter.set.call(input, prompt);
                    } else {
                        input.value = prompt;
                    }
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    setTimeout(function() {
                        var btns = document.querySelectorAll('button[type="submit"], button[aria-label*="send" i], button[aria-label*="Send"]');
                        var btn = null;
                        for (var i = 0; i < btns.length; i++) {
                            if (!btns[i].disabled) { btn = btns[i]; break; }
                        }
                        if (btn) { btn.click(); }
                        else {
                            input.dispatchEvent(new KeyboardEvent('keydown', {
                                key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                                bubbles: true, cancelable: true
                            }));
                        }
                    }, 200);
                    return;
                }

                // Strategy 2: ProseMirror / contenteditable.
                var pm = document.querySelector('.ProseMirror')
                    || document.querySelector('[contenteditable="true"]')
                    || document.querySelector('[role="textbox"]');
                if (pm) {
                    pm.focus();
                    pm.innerHTML = '';
                    document.execCommand('insertText', false, prompt);
                    pm.dispatchEvent(new Event('input', { bubbles: true }));
                    setTimeout(function() {
                        pm.dispatchEvent(new KeyboardEvent('keydown', {
                            key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                            bubbles: true, cancelable: true
                        }));
                    }, 200);
                    return;
                }

                // Strategy 3: any text input.
                var inputs = document.querySelectorAll('input[type="text"]');
                if (inputs.length > 0) {
                    var input = inputs[inputs.length - 1];
                    input.focus();
                    var nativeSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLInputElement.prototype, 'value'
                    );
                    if (nativeSetter && nativeSetter.set) {
                        nativeSetter.set.call(input, prompt);
                    } else {
                        input.value = prompt;
                    }
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    setTimeout(function() {
                        input.dispatchEvent(new KeyboardEvent('keydown', {
                            key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                            bubbles: true, cancelable: true
                        }));
                    }, 200);
                    return;
                }

                log('NO_INPUT_FOUND');
            })();
        """.trimIndent()
    }
}
