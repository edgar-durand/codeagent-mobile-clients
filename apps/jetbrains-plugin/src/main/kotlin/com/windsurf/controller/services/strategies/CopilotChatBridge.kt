package com.windsurf.controller.services.strategies

import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.components.ComponentManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.project.Project
import java.lang.reflect.InvocationHandler
import java.lang.reflect.Proxy

/**
 * Programmatic bridge to GitHub Copilot Chat's internal `CopilotChatService`.
 *
 * **Why this exists:** for months the plugin tried to drive the Copilot
 * Chat panel by walking the Swing tree, finding the input + the Send
 * button, and clicking it. That path is fundamentally fragile because
 * Copilot's panel is rendered with Jetpack Compose + Jewel, not Swing —
 * `tw.contentManager.contents` is empty, the "Send" tooltip is built
 * lazily on hover, and the input/button often aren't even in the Swing
 * tree until layout completes. Falling back to `Robot.keyPress(Cmd+V)`
 * pasted prompts into the user's terminal more than once.
 *
 * **What this is:** the GitHub Copilot for JetBrains plugin (verified
 * against 1.9.0-251, ships May 2026) registers an internal project
 * service `com.github.copilot.api.CopilotChatService` whose `query(...)`
 * method:
 *
 *   1. Publishes `ShowChatToolWindowsListener.TOPIC.showChatToolWindow()`
 *      on the project message bus → the chat tool window opens / focuses
 *      itself, **without** the IDE needing OS focus.
 *   2. Resolves a session (`NewSession` / `CurrentSession` / explicit
 *      sessionId) via `CopilotAgentSessionManager.getOrCreate*` and
 *      activates it.
 *   3. Calls `CopilotAgentSessionManager.sendMessage(sessionId, queryMessage,
 *      dataContext, ProgressHandler)` — the same code path the user's
 *      keystroke goes through when they click Send.
 *   4. Drives `onComplete` / `onError` / `onCancel` callbacks back to us.
 *
 * The package is `com.github.copilot.api` — it's not annotated
 * `@ApiStatus.Experimental` and not in any released SDK module, so
 * it's effectively private API. We resolve it via reflection through
 * the Copilot plugin's classloader so we don't pin a build dependency
 * (users without Copilot can still install our plugin) and so a future
 * rename in Copilot only fails the bridge, not the whole strategy —
 * the Swing/Robot fallback still kicks in.
 *
 * **Sources:**
 *   - GitHub community discussion #172311 (Sep 2025) and #175540
 *     (Oct 2025) — both confirm "no public API" was the official
 *     guidance, but the package shipped in 1.9.0-251 anyway.
 *   - `lib/core.jar/META-INF/copilot-core.xml` lines 127–128 register
 *     the project service.
 *   - Disassembled `CopilotChatServiceImpl.query` confirms the call
 *     order above.
 */
internal object CopilotChatBridge {
    private val log = Logger.getInstance(CopilotChatBridge::class.java)
    private val COPILOT_PLUGIN_ID = PluginId.getId("com.github.copilot")

    /**
     * Submit `prompt` to Copilot Chat. Returns:
     *   - `true` if the prompt was successfully dispatched into Copilot's
     *     internal pipeline. The `onAssistantDone` callback (if provided)
     *     fires when the assistant's reply finishes, on a Copilot worker
     *     thread.
     *   - `false` if Copilot is not installed/enabled OR the internal API
     *     surface has moved. Caller MUST treat this as a hard failure
     *     and fall back to its own delivery path (Swing-direct / JCEF /
     *     Robot Cmd+V) — we never silently succeed if the call didn't
     *     reach Copilot.
     */
    fun submit(
        project: Project,
        prompt: String,
        useAgentMode: Boolean = true,
        useCurrentSession: Boolean = true,
        onAssistantDone: () -> Unit = {},
        onError: (String) -> Unit = {},
        onCancel: () -> Unit = {},
    ): Boolean {
        val plugin = PluginManagerCore.getPlugin(COPILOT_PLUGIN_ID)
        if (plugin == null) {
            log.info("CopilotChatBridge: com.github.copilot plugin not installed")
            return false
        }
        if (!plugin.isEnabled) {
            log.info("CopilotChatBridge: com.github.copilot plugin is disabled")
            return false
        }
        val cl = plugin.pluginClassLoader
        if (cl == null) {
            log.warn("CopilotChatBridge: pluginClassLoader is null")
            return false
        }

        return try {
            val serviceIface = Class.forName("com.github.copilot.api.CopilotChatService", false, cl)
            val builderClass = Class.forName("com.github.copilot.api.QueryOptionBuilder", false, cl)
            // FunctionN interfaces live in kotlin-stdlib, available on the
            // platform classloader. Loading via Copilot's classloader is
            // safe because stdlib is shared.
            val function0Iface = Class.forName("kotlin.jvm.functions.Function0", false, cl)
            val function1Iface = Class.forName("kotlin.jvm.functions.Function1", false, cl)
            val function5Iface = Class.forName("kotlin.jvm.functions.Function5", false, cl)

            val getService = ComponentManager::class.java
                .getMethod("getService", Class::class.java)
            val service = getService.invoke(project, serviceIface)
            if (service == null) {
                log.warn("CopilotChatBridge: project service ${serviceIface.name} returned null")
                return false
            }

            // Build a Function1<QueryOptionBuilder, Unit> that configures
            // the query — Copilot's signature is
            // `query(DataContext, Function1<QueryOptionBuilder, Unit>)`.
            val configurer = Proxy.newProxyInstance(
                cl, arrayOf(function1Iface),
                InvocationHandler { _, method, args ->
                    if (method.name != "invoke") return@InvocationHandler null
                    val builder = args[0]
                    configureBuilder(
                        cl, builderClass, builder,
                        prompt = prompt,
                        useAgentMode = useAgentMode,
                        useCurrentSession = useCurrentSession,
                        onAssistantDone = onAssistantDone,
                        onError = onError,
                        onCancel = onCancel,
                        function0Iface = function0Iface,
                        function5Iface = function5Iface,
                    )
                    Unit
                },
            )

            val queryMethod = serviceIface.getMethod(
                "query", DataContext::class.java, function1Iface,
            )

            // The impl launches its own coroutine and dispatches to EDT
            // internally; we don't have to be on EDT, and the IDE doesn't
            // need OS focus.
            queryMethod.invoke(service, DataContext.EMPTY_CONTEXT, configurer)
            log.info("CopilotChatBridge: query dispatched (${prompt.length} chars, agentMode=$useAgentMode, currentSession=$useCurrentSession)")
            true
        } catch (t: Throwable) {
            // Any reflection failure (class moved, signature changed,
            // exception inside Copilot) lands here. Log once, return
            // false so the caller can fall back.
            log.warn("CopilotChatBridge: internal API not reachable: ${t.javaClass.simpleName}: ${t.message}")
            false
        }
    }

    private fun configureBuilder(
        cl: ClassLoader,
        builderClass: Class<*>,
        builder: Any,
        prompt: String,
        useAgentMode: Boolean,
        useCurrentSession: Boolean,
        onAssistantDone: () -> Unit,
        onError: (String) -> Unit,
        onCancel: () -> Unit,
        function0Iface: Class<*>,
        function5Iface: Class<*>,
    ) {
        builderClass.getMethod("withInput", String::class.java).invoke(builder, prompt)

        if (useCurrentSession) {
            builderClass.getMethod("withCurrentSession").invoke(builder)
        } else {
            builderClass.getMethod("withNewSession").invoke(builder)
        }

        if (useAgentMode) {
            builderClass.getMethod("withAgentMode").invoke(builder)
        } else {
            builderClass.getMethod("withAskMode").invoke(builder)
        }

        builderClass.getMethod("onComplete", function0Iface)
            .invoke(builder, function0Proxy(cl, function0Iface) { onAssistantDone() })

        builderClass.getMethod("onCancel", function0Iface)
            .invoke(builder, function0Proxy(cl, function0Iface) { onCancel() })

        // onError signature: (String, Int?, String, String, String) -> Unit.
        // arg0 looks like a category, arg2 is the human-readable message;
        // we pass through both joined.
        val errorProxy = Proxy.newProxyInstance(
            cl, arrayOf(function5Iface),
            InvocationHandler { _, method, args ->
                if (method.name == "invoke") {
                    val msg = listOfNotNull(args.getOrNull(0), args.getOrNull(2)).joinToString(" — ")
                    onError(msg)
                }
                Unit
            },
        )
        builderClass.getMethod("onError", function5Iface).invoke(builder, errorProxy)
    }

    private fun function0Proxy(cl: ClassLoader, function0Iface: Class<*>, run: () -> Unit): Any =
        Proxy.newProxyInstance(
            cl, arrayOf(function0Iface),
            InvocationHandler { _, method, _ ->
                if (method.name == "invoke") run()
                Unit
            },
        )
}
