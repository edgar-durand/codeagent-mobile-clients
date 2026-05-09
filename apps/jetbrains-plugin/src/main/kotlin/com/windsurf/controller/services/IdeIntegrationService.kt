package com.windsurf.controller.services

import com.intellij.ide.plugins.PluginManager
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.util.Ref
import com.intellij.openapi.util.SystemInfo
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowManager
import java.awt.Component
import java.awt.Container
import java.awt.datatransfer.StringSelection
import java.awt.event.KeyEvent
import java.awt.Robot
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import javax.swing.AbstractButton
import javax.swing.text.JTextComponent

data class DetectedAgent(
    val id: String,
    val name: String,
    val pluginId: String,
    val toolWindowId: String,
    val icon: String,
    val installed: Boolean
)

@Service(Service.Level.APP)
class IdeIntegrationService {

    private val logger = Logger.getInstance(IdeIntegrationService::class.java)
    private var projectRef: WeakReference<Project>? = null

    data class KnownAgent(
        val pluginId: String,
        val name: String,
        val toolWindowIds: List<String>,
        val icon: String
    )

    private val knownAgents = listOf(
        KnownAgent("com.intellij.ai", "JetBrains AI Assistant", listOf("AIAssistant", "AI Assistant", "JetBrains AI Assistant"), "jetbrains-ai"),
        KnownAgent("com.github.copilot", "GitHub Copilot", listOf("GitHub Copilot Chat"), "copilot"),
        KnownAgent("com.codeium.intellij", "Codeium / Windsurf", listOf("Codeium Chat", "Codeium", "Cascade", "Windsurf"), "codeium"),
        KnownAgent("com.anthropic.claude", "Claude Code", listOf("Claude", "Claude Code"), "claude"),
        KnownAgent("anthropic.claude", "Claude Code", listOf("Claude", "Claude Code"), "claude"),
        KnownAgent("com.tabnine.TabNine", "Tabnine", listOf("Tabnine Chat", "Tabnine"), "tabnine"),
        KnownAgent("amazon.q", "Amazon Q", listOf("Amazon Q", "Amazon Q Chat"), "amazon-q"),
        KnownAgent("com.sourcegraph.cody", "Sourcegraph Cody", listOf("Cody", "Cody Chat"), "cody"),
        KnownAgent("com.cursor.ide", "Cursor", listOf("Cursor Chat", "Cursor"), "cursor"),
        KnownAgent("com.jetbrains.junie", "Junie", listOf("Junie"), "junie")
    )

    private val aiKeywords = listOf(
        "ai", "copilot", "assistant", "claude", "cody", "cursor",
        "cascade", "windsurf", "codeium", "tabnine", "gemini", "codey",
        "supermaven", "continue", "aider", "llm", "gpt", "anthropic"
    )

    private val pluginNameKeywords = listOf(
        "ai assistant", "copilot", "claude", "cody", "cascade", "windsurf",
        "codeium", "tabnine", "gemini", "supermaven", "continue", "aider",
        "code companion", "chatgpt", "anthropic", "openai", "amazon q"
    )

    private val excludedPluginIds = setOf(
        "com.codeagent.mobile"
    )

    // Tool window IDs that are code completions/suggestions/logs, NOT chat — must never be used as prompt targets.
    // Exact matches first, plus a contains-based rule for any non-chat Copilot panel
    // (Multiple Code Suggestions, MCP Log, raw github.copilotToolWindow, etc.).
    private val completionToolWindowIds = setOf(
        "github copilot", "copilot"
    )

    private fun isNonChatPromptTarget(twId: String): Boolean {
        val lower = twId.lowercase()
        if (completionToolWindowIds.contains(lower)) return true
        // Any Copilot tool window that isn't the actual Chat panel — e.g.
        // "GitHub Copilot Multiple Code Suggestions", "GitHub Copilot MCP Log",
        // "github.copilotToolWindow". The mobile app should never see these as
        // selectable agents and the prompt router must never activate them.
        if (lower.contains("copilot") && !lower.contains("chat")) return true
        return false
    }

    private var cachedAgents: List<DetectedAgent>? = null

    fun setProject(project: Project) {
        projectRef = WeakReference(project)
        cachedAgents = null
    }

    private fun getProject(): Project? {
        return projectRef?.get() ?: ProjectManager.getInstance().openProjects.firstOrNull()
    }

    fun detectInstalledAgents(): List<DetectedAgent> {
        cachedAgents?.let { return it }

        val detected = mutableListOf<DetectedAgent>()
        val seenPluginIds = mutableSetOf<String>()

        for (agent in knownAgents) {
            val pluginIdObj = PluginId.getId(agent.pluginId)
            val plugin = PluginManagerCore.getPlugin(pluginIdObj)
            val isInstalled = plugin != null && !PluginManagerCore.isDisabled(pluginIdObj)
            if (isInstalled) {
                detected.add(
                    DetectedAgent(
                        id = agent.pluginId,
                        name = agent.name,
                        pluginId = agent.pluginId,
                        toolWindowId = agent.toolWindowIds.first(),
                        icon = agent.icon,
                        installed = true
                    )
                )
                seenPluginIds.add(agent.pluginId)
                logger.info("Detected known AI plugin: ${agent.name} (${agent.pluginId})")
            }
        }

        val allPlugins = PluginManager.getPlugins()
        for (descriptor in allPlugins) {
            val pid = descriptor.pluginId?.idString ?: continue
            if (PluginManagerCore.isDisabled(descriptor.pluginId!!)) continue
            if (pid in seenPluginIds || pid in excludedPluginIds) continue

            val pluginName = descriptor.name.lowercase()
            val pluginDesc = (descriptor.description ?: "").lowercase()

            val matchesName = pluginNameKeywords.any { pluginName.contains(it) }
            val matchesDesc = pluginNameKeywords.any { pluginDesc.contains(it) }

            if (matchesName || matchesDesc) {
                val icon = resolveIconForPlugin(pluginName)
                detected.add(
                    DetectedAgent(
                        id = pid,
                        name = descriptor.name,
                        pluginId = pid,
                        toolWindowId = descriptor.name,
                        icon = icon,
                        installed = true
                    )
                )
                seenPluginIds.add(pid)
                logger.info("Detected AI plugin dynamically: ${descriptor.name} ($pid)")
            }
        }

        val toolWindowAgents = scanToolWindowsOnEdt()
        for (twAgent in toolWindowAgents) {
            // Never use completions/suggestions/log windows as chat targets
            if (isNonChatPromptTarget(twAgent.toolWindowId)) continue

            val existing = detected.find {
                it.name.lowercase() == twAgent.name.lowercase() ||
                it.toolWindowId.lowercase() == twAgent.toolWindowId.lowercase() ||
                it.name.lowercase().contains(twAgent.toolWindowId.lowercase()) ||
                twAgent.toolWindowId.lowercase().contains(it.name.lowercase().split(" ").first())
            }
            if (existing != null) {
                val idx = detected.indexOf(existing)
                detected[idx] = existing.copy(toolWindowId = twAgent.toolWindowId)
                logger.info("Resolved tool window for ${existing.name}: ${twAgent.toolWindowId}")
            } else {
                detected.add(twAgent)
            }
        }

        // Always register terminal-based agents (they can be launched on demand)
        for (config in TerminalAgentService.TERMINAL_AGENTS) {
            val existing = detected.find {
                it.name.equals(config.name, ignoreCase = true) ||
                it.pluginId == config.pluginId ||
                (config.id == "claude_code" && isClaudeCodeAgent(it))
            }
            if (existing != null) {
                val idx = detected.indexOf(existing)
                detected[idx] = existing.copy(toolWindowId = "__terminal__:${config.id}")
                logger.info("Updated ${config.name} to terminal routing")
            } else {
                detected.add(DetectedAgent(
                    id = config.id,
                    name = config.name,
                    pluginId = config.pluginId,
                    toolWindowId = "__terminal__:${config.id}",
                    icon = config.icon,
                    installed = true
                ))
                logger.info("Added terminal agent: ${config.name}")
            }
        }

        cachedAgents = detected
        logger.info("Total detected agents: ${detected.size}. Names: ${detected.map { "${it.name}(${it.toolWindowId})" }.joinToString(", ")}")
        return detected
    }

    private fun resolveIconForPlugin(nameLower: String): String {
        return when {
            nameLower.contains("claude") || nameLower.contains("anthropic") -> "claude"
            nameLower.contains("copilot") -> "copilot"
            nameLower.contains("codeium") || nameLower.contains("windsurf") || nameLower.contains("cascade") -> "codeium"
            nameLower.contains("tabnine") -> "tabnine"
            nameLower.contains("cody") -> "cody"
            nameLower.contains("amazon") -> "amazon-q"
            nameLower.contains("junie") -> "junie"
            nameLower.contains("gemini") -> "jetbrains-ai"
            nameLower.contains("cursor") -> "cursor"
            else -> "generic-ai"
        }
    }

    private fun scanToolWindowsOnEdt(): List<DetectedAgent> {
        val project = getProject() ?: return emptyList()
        val result = AtomicReference<List<DetectedAgent>>(emptyList())

        val app = ApplicationManager.getApplication()
        val task = Runnable {
            try {
                val twManager = ToolWindowManager.getInstance(project)
                val allIds = twManager.toolWindowIds.toList()
                logger.info("All available tool windows: ${allIds.joinToString(", ")}")

                val detected = mutableListOf<DetectedAgent>()
                val knownToolWindowIds = knownAgents.flatMap { it.toolWindowIds }.map { it.lowercase() }.toSet()
                val selfId = "codeagent-mobile"

                for (agent in knownAgents) {
                    for (twId in agent.toolWindowIds) {
                        if (twManager.getToolWindow(twId) != null) {
                            detected.add(
                                DetectedAgent(
                                    id = agent.pluginId,
                                    name = agent.name,
                                    pluginId = agent.pluginId,
                                    toolWindowId = twId,
                                    icon = agent.icon,
                                    installed = true
                                )
                            )
                            logger.info("Found known AI tool window: $twId -> ${agent.name}")
                            break
                        }
                    }
                }

                for (twId in allIds) {
                    val lower = twId.lowercase()
                    if (lower == selfId) continue
                    if (knownToolWindowIds.contains(lower)) continue
                    if (isNonChatPromptTarget(twId)) continue
                    if (detected.any { it.toolWindowId == twId }) continue

                    if (aiKeywords.any { lower.contains(it) }) {
                        detected.add(
                            DetectedAgent(
                                id = "custom:$twId",
                                name = twId,
                                pluginId = "unknown",
                                toolWindowId = twId,
                                icon = "generic-ai",
                                installed = true
                            )
                        )
                        logger.info("Found AI-related tool window: $twId")
                    }
                }

                result.set(detected)
            } catch (e: Exception) {
                logger.warn("Tool window scan failed: ${e.message}")
            }
        }

        if (app.isDispatchThread) {
            task.run()
        } else {
            try {
                app.invokeAndWait(task)
            } catch (e: Exception) {
                logger.warn("invokeAndWait failed, running directly: ${e.message}")
                task.run()
            }
        }

        return result.get()
    }

    fun sendPromptToAgent(prompt: String, agentId: String? = null): Boolean {
        logger.info("Sending prompt to agent=${agentId ?: "auto"}: ${prompt.take(50)}...")

        cachedAgents = null

        val project = getProject()
        if (project == null) {
            logger.warn("No project available")
            CopyPasteManager.getInstance().setContents(StringSelection(prompt))
            showNotification("Prompt copied to clipboard (no project)", prompt)
            return false
        }

        val agents = detectInstalledAgents()
        logger.info("Available agents for prompt: ${agents.map { "${it.name}(${it.toolWindowId})" }.joinToString(", ")}")

        val targetAgent = if (agentId != null) {
            agents.find { it.id == agentId }
        } else {
            agents.firstOrNull()
        }

        // Route terminal-based agents (they run in a terminal, not a tool window)
        if (targetAgent != null && targetAgent.toolWindowId.startsWith("__terminal__:")) {
            val configId = targetAgent.toolWindowId.removePrefix("__terminal__:")
            val config = TerminalAgentService.TERMINAL_AGENTS.find { it.id == configId }
            if (config != null) {
                logger.info("Routing to TerminalAgentService for ${config.name}")
                val terminalService = TerminalAgentService.getInstance()
                terminalService.setProject(project)
                val sent = terminalService.sendPromptToTerminalAgent(prompt, config)
                logger.info("TerminalAgentService.sendPromptToTerminalAgent returned: $sent")
                if (sent) {
                    showNotification("Prompt sent to ${config.name}", prompt)
                    return true
                }
                CopyPasteManager.getInstance().setContents(StringSelection(prompt))
                showNotification("Prompt copied to clipboard (${config.name} not accessible)", prompt)
                return false
            }
        }

        val app = ApplicationManager.getApplication()
        val activated = Ref.create(false)
        val jcefBrowserRef = AtomicReference<Any?>(null)

        val activateTask = Runnable {
            try {
                val tw = findToolWindow(project, targetAgent, agents)
                if (tw != null) {
                    logger.info("Activating tool window: ${tw.id}")
                    tw.show()
                    tw.activate(null)
                    activated.set(true)

                    // Find the JCEF browser component inside the tool window
                    for (content in tw.contentManager.contents) {
                        val component = content.component ?: continue
                        val browser = findJBCefBrowser(component)
                        if (browser != null) {
                            jcefBrowserRef.set(browser)
                            logger.info("Found JCEF browser in tool window: ${tw.id}")
                            break
                        }
                    }
                } else {
                    logger.warn("No AI tool window could be activated.")
                }
            } catch (e: Exception) {
                logger.error("Error activating tool window: ${e.message}", e)
            }
        }

        if (app.isDispatchThread) {
            activateTask.run()
        } else {
            try {
                app.invokeAndWait(activateTask)
            } catch (e: Exception) {
                logger.warn("invokeAndWait for activation failed: ${e.message}")
                activateTask.run()
            }
        }

        if (!activated.get()) {
            CopyPasteManager.getInstance().setContents(StringSelection(prompt))
            showNotification("Prompt copied to clipboard (no AI agent found)", prompt)
            return false
        }

        // Copilot Chat is rendered ENTIRELY in Swing (not JCEF) — find its
        // CopilotAgentInputTextArea + click the send button directly. This
        // fixes the "first prompt lost" race: when the panel just opened
        // cold, the input wasn't focused yet and the previous clipboard +
        // Robot Cmd+V fallback would paste into the wrong place. We retry
        // for up to 3 s while the Swing tree is still mounting.
        if (targetAgent != null && isCopilotChatAgent(targetAgent)) {
            val twForCopilot = ApplicationManager.getApplication().let { app ->
                val ref = AtomicReference<com.intellij.openapi.wm.ToolWindow?>(null)
                val task = Runnable { ref.set(ToolWindowManager.getInstance(project).getToolWindow(targetAgent.toolWindowId)) }
                if (app.isDispatchThread) task.run() else try { app.invokeAndWait(task) } catch (_: Exception) {}
                ref.get()
            }
            if (twForCopilot != null) {
                val sent = trySwingCopilotPromptInjection(twForCopilot, prompt, maxWaitMs = 3000L)
                if (sent) {
                    showNotification("Prompt sent to ${targetAgent.name}", prompt)
                    return true
                }
                logger.warn("Copilot Swing injection failed; falling back to JCEF/Robot")
            }
        }

        val jcefBrowser = jcefBrowserRef.get()
        if (jcefBrowser != null) {
            // Pure JCEF JS injection — no Robot paste needed, works regardless of focus state
            val sent = executeJcefPromptInjection(jcefBrowser, prompt)
            if (sent) {
                showNotification("Prompt sent to AI", prompt)
                return true
            }
            logger.warn("JCEF JS injection failed, falling back to Robot paste")
        }

        // Fallback: clipboard + Robot paste for non-JCEF tool windows
        CopyPasteManager.getInstance().setContents(StringSelection(prompt))
        app.invokeLater {
            Thread.sleep(800)
            simulatePasteAndSubmit()
        }
        showNotification("Prompt sent to AI", prompt)
        return true
    }

    fun sendPromptToIde(prompt: String): Boolean {
        return sendPromptToAgent(prompt, null)
    }

    private fun executeJcefPromptInjection(browser: Any, prompt: String): Boolean {
        try {
            val platformCL = browser.javaClass.classLoader
            val jbCefBaseClass = Class.forName("com.intellij.ui.jcef.JBCefBrowserBase", true, platformCL)
            val cefBrowser = jbCefBaseClass.getMethod("getCefBrowser").invoke(browser) ?: return false
            val cefBrowserIface = Class.forName("org.cef.browser.CefBrowser", true, cefBrowser.javaClass.classLoader)

            val escapedPrompt = prompt
                .replace("\\", "\\\\")
                .replace("`", "\\`")
                .replace("\$", "\\\$")
                .replace("\n", "\\n")
                .replace("\r", "\\r")

            val js = """
                (function() {
                    var log = function(msg) { console.log('__CAGENT__:INJECT:' + msg); };
                    var prompt = `$escapedPrompt`;

                    // Strategy 1: Find textarea (most common for chat inputs)
                    var ta = document.querySelectorAll('textarea');
                    if (ta.length > 0) {
                        var input = ta[ta.length - 1];
                        log('found_textarea_count=' + ta.length);
                        input.focus();
                        // Use native setter to bypass React controlled component
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
                        log('textarea_value_set');

                        // Submit after a short delay
                        setTimeout(function() {
                            // Try submit button first
                            var btns = document.querySelectorAll('button[type="submit"], button[aria-label*="send" i], button[aria-label*="Send"]');
                            var btn = null;
                            for (var i = 0; i < btns.length; i++) {
                                if (!btns[i].disabled) { btn = btns[i]; break; }
                            }
                            if (btn) {
                                log('clicking_submit_button');
                                btn.click();
                            } else {
                                // Dispatch Enter key
                                log('dispatching_enter_key');
                                input.dispatchEvent(new KeyboardEvent('keydown', {
                                    key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                                    bubbles: true, cancelable: true
                                }));
                            }
                        }, 200);
                        return;
                    }

                    // Strategy 2: ProseMirror or contenteditable
                    var pm = document.querySelector('.ProseMirror')
                        || document.querySelector('[contenteditable="true"]')
                        || document.querySelector('[role="textbox"]');
                    if (pm) {
                        log('found_editable:' + pm.tagName + ':' + (pm.className || '').substring(0, 40));
                        pm.focus();
                        // Clear and insert text
                        pm.innerHTML = '';
                        document.execCommand('insertText', false, prompt);
                        pm.dispatchEvent(new Event('input', { bubbles: true }));
                        log('editable_text_inserted');

                        setTimeout(function() {
                            pm.dispatchEvent(new KeyboardEvent('keydown', {
                                key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                                bubbles: true, cancelable: true
                            }));
                            log('enter_dispatched');
                        }, 200);
                        return;
                    }

                    // Strategy 3: Any input element
                    var inputs = document.querySelectorAll('input[type="text"]');
                    if (inputs.length > 0) {
                        var input = inputs[inputs.length - 1];
                        log('found_text_input');
                        input.focus();
                        input.value = prompt;
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
                    // Dump all interactive elements for debugging
                    var all = document.querySelectorAll('textarea, input, [contenteditable], [role="textbox"], .ProseMirror');
                    log('interactive_elements=' + all.length);
                    for (var k = 0; k < Math.min(all.length, 5); k++) {
                        log('el[' + k + '] tag=' + all[k].tagName + ' class=' + (all[k].className || '').substring(0, 60));
                    }
                })();
            """.trimIndent()

            val execMethod = cefBrowserIface.getMethod(
                "executeJavaScript", String::class.java, String::class.java, Int::class.javaPrimitiveType
            )
            execMethod.invoke(cefBrowser, js, "about:blank", 0)
            logger.info("JCEF prompt injection executed")
            return true
        } catch (e: Exception) {
            logger.warn("JCEF prompt injection failed: ${e.message}")
            return false
        }
    }

    private fun findJBCefBrowser(component: Component): Any? {
        val className = component.javaClass.name
        if (className.contains("\$MyPanel") && className.contains("JBCef")) {
            try {
                val outerField = component.javaClass.getDeclaredField("this\$0")
                outerField.isAccessible = true
                val outer = outerField.get(component)
                if (outer != null) return outer
            } catch (_: Exception) {}
        }
        if (component is Container) {
            for (i in 0 until component.componentCount) {
                val found = findJBCefBrowser(component.getComponent(i))
                if (found != null) return found
            }
        }
        return null
    }

    private fun findToolWindow(project: Project, targetAgent: DetectedAgent?, agents: List<DetectedAgent>): ToolWindow? {
        val twManager = ToolWindowManager.getInstance(project)

        if (targetAgent != null) {
            // Try the declared toolWindowId first.
            val tw = twManager.getToolWindow(targetAgent.toolWindowId)
            if (tw != null) return tw

            // Try every alternate window declared for this known plugin —
            // e.g. JetBrains AI publishes both "AI Assistant" and "AIAssistant"
            // depending on IDE/plugin version. Falling back through the list
            // keeps the user on THEIR selected agent instead of jumping
            // to a different vendor's window.
            val matchingKnown = knownAgents.firstOrNull { it.pluginId == targetAgent.pluginId }
            if (matchingKnown != null) {
                for (twId in matchingKnown.toolWindowIds) {
                    if (isNonChatPromptTarget(twId)) continue
                    val candidate = twManager.getToolWindow(twId)
                    if (candidate != null) return candidate
                }
            }

            // Specific agent was requested but not found. Do NOT silently
            // open an unrelated AI tool window — that's how selecting
            // "JetBrains AI Assistant" used to end up activating
            // "GitHub Copilot Multiple Code Suggestions". Fail closed
            // and let the caller fall back to clipboard.
            logger.warn("Target tool window not found: ${targetAgent.toolWindowId} (agent=${targetAgent.name}); refusing to substitute another AI window")
            return null
        }

        for (agent in agents) {
            if (isClaudeCodeAgent(agent)) continue
            if (isNonChatPromptTarget(agent.toolWindowId)) continue
            val tw = twManager.getToolWindow(agent.toolWindowId)
            if (tw != null) return tw
        }

        for (twId in twManager.toolWindowIds) {
            val lower = twId.lowercase()
            if (lower == "codeagent-mobile") continue
            if (isNonChatPromptTarget(twId)) continue
            if (aiKeywords.any { lower.contains(it) }) {
                val tw = twManager.getToolWindow(twId)
                if (tw != null) return tw
            }
        }

        logger.warn("No AI tool window found. Available: ${twManager.toolWindowIds.joinToString(", ")}")
        return null
    }

    private fun simulatePasteAndSubmit() {
        try {
            val robot = Robot()
            robot.autoDelay = 50

            if (SystemInfo.isMac) {
                robot.keyPress(KeyEvent.VK_META)
                robot.keyPress(KeyEvent.VK_V)
                robot.keyRelease(KeyEvent.VK_V)
                robot.keyRelease(KeyEvent.VK_META)
            } else {
                robot.keyPress(KeyEvent.VK_CONTROL)
                robot.keyPress(KeyEvent.VK_V)
                robot.keyRelease(KeyEvent.VK_V)
                robot.keyRelease(KeyEvent.VK_CONTROL)
            }

            Thread.sleep(300)
            robot.keyPress(KeyEvent.VK_ENTER)
            robot.keyRelease(KeyEvent.VK_ENTER)
        } catch (e: Exception) {
            logger.warn("Robot simulation failed: ${e.message}")
        }
    }

    private fun isCopilotChatAgent(agent: DetectedAgent): Boolean {
        if (agent.pluginId.equals("com.github.copilot", ignoreCase = true)) return true
        return agent.toolWindowId.equals("GitHub Copilot Chat", ignoreCase = true)
    }

    /**
     * Direct Swing prompt injection for Copilot Chat: walks the tool
     * window's component tree, finds `CopilotAgentInputTextArea`, sets
     * its text to `prompt`, then clicks the send button inside
     * `SendStopActionButtonPanel`. Verifies the click *actually
     * dispatched* by checking that the input cleared shortly after —
     * a cold-open Copilot panel sometimes finds the button but the
     * doClick is a no-op until Compose Desktop finishes activating
     * it, so we have to retry until we see the input go empty. Without
     * this verification the very first prompt after the chat opens is
     * silently discarded.
     */
    private fun trySwingCopilotPromptInjection(
        tw: com.intellij.openapi.wm.ToolWindow,
        prompt: String,
        maxWaitMs: Long,
    ): Boolean {
        val app = ApplicationManager.getApplication()
        val deadline = System.currentTimeMillis() + maxWaitMs
        while (System.currentTimeMillis() < deadline) {
            val sentRef = AtomicBoolean(false)
            val attemptedRef = AtomicReference<JTextComponent?>(null)
            val task = Runnable {
                try {
                    val (attempted, input) = performCopilotSwingInjection(tw, prompt)
                    sentRef.set(attempted)
                    attemptedRef.set(input)
                } catch (e: Exception) {
                    logger.debug("Copilot Swing injection iteration failed: ${e.message}")
                }
            }
            if (app.isDispatchThread) task.run() else {
                try { app.invokeAndWait(task) } catch (_: Exception) {}
            }
            if (sentRef.get()) {
                // Verify the click actually submitted by checking that the
                // input cleared. Compose-backed buttons silently no-op on
                // their first doClick when the panel just mounted — the
                // text stays in the field and the prompt never reaches
                // Copilot. If we see the prompt still in the input, retry.
                try { Thread.sleep(200) } catch (_: InterruptedException) { return false }
                val cleared = AtomicBoolean(true)
                val verifyTask = Runnable {
                    val input = attemptedRef.get()
                    if (input != null) {
                        val current = (input.text ?: "").trim()
                        if (current == prompt.trim() && current.isNotBlank()) {
                            cleared.set(false)
                        }
                    }
                }
                if (app.isDispatchThread) verifyTask.run() else {
                    try { app.invokeAndWait(verifyTask) } catch (_: Exception) {}
                }
                if (cleared.get()) return true
                logger.info("Copilot Swing injection: click did not submit (input still has prompt) — retrying")
            }
            try { Thread.sleep(120) } catch (_: InterruptedException) { return false }
        }
        return false
    }

    /**
     * Returns (attempted, inputComponent). `attempted = true` means we
     * found the input and dispatched the click/Enter; the caller still
     * has to verify the click took effect. The input reference is
     * returned so the caller can re-check its contents off-EDT later.
     */
    private fun performCopilotSwingInjection(
        tw: com.intellij.openapi.wm.ToolWindow,
        prompt: String,
    ): Pair<Boolean, JTextComponent?> {
        var inputArea: JTextComponent? = null
        var sendButton: AbstractButton? = null

        fun walk(c: Component) {
            val cls = c.javaClass.name
            if (inputArea == null && cls.endsWith(".CopilotAgentInputTextArea") && c is JTextComponent) {
                inputArea = c
            }
            if (sendButton == null && cls.endsWith(".SendStopActionButtonPanel")) {
                fun findBtn(node: Component): AbstractButton? {
                    if (node is AbstractButton && node.isVisible && node.isEnabled) return node
                    if (node is Container) {
                        for (i in 0 until node.componentCount) {
                            val found = findBtn(node.getComponent(i))
                            if (found != null) return found
                        }
                    }
                    return null
                }
                findBtn(c)?.let { sendButton = it }
            }
            if (c is Container) {
                for (i in 0 until c.componentCount) walk(c.getComponent(i))
            }
        }

        for (content in tw.contentManager.contents) {
            val component = content.component ?: continue
            walk(component)
        }

        val input = inputArea ?: return false to null
        input.text = prompt
        input.caretPosition = prompt.length
        input.requestFocusInWindow()

        val btn = sendButton
        if (btn != null) {
            btn.doClick()
            logger.info("Copilot Swing injection: setText + clicked ${btn.javaClass.simpleName}")
            return true to input
        }
        // No send button found — dispatch an Enter key on the input as a
        // last resort. Many text inputs in IntelliJ map Enter to submit.
        val enter = KeyEvent(input, KeyEvent.KEY_PRESSED, System.currentTimeMillis(), 0, KeyEvent.VK_ENTER, '\n')
        input.dispatchEvent(enter)
        logger.info("Copilot Swing injection: send button missing, dispatched Enter")
        return true to input
    }

    private fun isClaudeCodeAgent(agent: DetectedAgent): Boolean {
        return agent.pluginId.contains("anthropic", ignoreCase = true) ||
               agent.pluginId.contains("claude", ignoreCase = true) ||
               agent.name.contains("Claude Code", ignoreCase = true)
    }

    private fun showNotification(title: String, content: String) {
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
    }
}
