package com.windsurf.controller.services.strategies

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.ComponentManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.project.Project
import com.windsurf.controller.services.PluginDescriptors

/** Context-window snapshot mirrored from Copilot's `ContextSizeInfo`. */
data class CopilotContextWindow(
    val used: Long,
    val total: Long,
    val percent: Int,
    val model: String?,
    val breakdown: Map<String, Double> = emptyMap(),
    /** Last quota / plan-exhausted message, mirrors CLI's `rateLimitReset`. */
    val rateLimitReset: String? = null,
)

data class CopilotModelInfo(
    val id: String,
    val label: String,
    val isDefault: Boolean,
    val family: String?,
    val preview: Boolean,
)

data class CopilotModelList(val active: String?, val all: List<CopilotModelInfo>)

/**
 * Reflection bridge to GitHub Copilot's internal model + context APIs.
 * Companion to `CopilotChatBridge` — same approach (reflection through
 * `com.github.copilot` plugin classloader), same fail-soft contract
 * (any exception → return null and let the caller decide).
 *
 * **Sources** (verified against `github-copilot-intellij` 1.9.0-251):
 *   - `com.github.copilot.agent.session.CopilotAgentSessionManager.getCurrentSessionController()`
 *   - controller → component → inputPanel → `contextUsagePieChart.contextSizeInfo`
 *   - `com.github.copilot.session.ChatService.getInstance(project).panelChat.value.activeSession`
 *   - `com.github.copilot.model.CompositeModelService.getModels().get(ModelScope.ChatPanel).value`
 *   - `com.github.copilot.session.ChatAction$ModelSelected(chatType, sessionId, modelId)` →
 *     `ChatService.dispatch(action)` for switching models
 *
 * The `ContextSizeInfo` is null until the first turn finishes — callers
 * must tolerate `readContextWindow` returning null on a fresh chat.
 */
internal object CopilotChatMetadataBridge {
    private val log = Logger.getInstance(CopilotChatMetadataBridge::class.java)
    private val COPILOT_PLUGIN_ID = PluginId.getId("com.github.copilot")

    private fun copilotClassLoader(): ClassLoader? {
        val plugin = PluginDescriptors.findById(COPILOT_PLUGIN_ID) ?: return null
        if (!plugin.isEnabled) return null
        return plugin.pluginClassLoader
    }

    /** Read the current context-window usage from Copilot's input panel. */
    fun readContextWindow(project: Project): CopilotContextWindow? {
        val cl = copilotClassLoader() ?: run {
            log.info("readContextWindow: Copilot classloader unavailable")
            return null
        }
        return try {
            val managerCls = Class.forName("com.github.copilot.agent.session.CopilotAgentSessionManager", false, cl)
            val getService = ComponentManager::class.java.getMethod("getService", Class::class.java)
            val manager = getService.invoke(project, managerCls)
            if (manager == null) {
                log.info("readContextWindow: CopilotAgentSessionManager not available")
                return null
            }
            val controller = managerCls.getMethod("getCurrentSessionController").invoke(manager)
            if (controller == null) {
                log.info("readContextWindow: getCurrentSessionController returned null (no agent session active)")
                return null
            }

            val controllerCls = Class.forName("com.github.copilot.agent.session.CopilotAgentSessionController", false, cl)
            val component = controllerCls.getMethod("getComponent").invoke(controller)
            if (component == null) {
                log.info("readContextWindow: controller.getComponent() returned null")
                return null
            }

            val componentCls = Class.forName("com.github.copilot.agent.session.component.CopilotAgentSessionComponent", false, cl)
            val inputPanel = componentCls.getMethod("getInputPanel").invoke(component)
            if (inputPanel == null) {
                log.info("readContextWindow: component.getInputPanel() returned null")
                return null
            }

            val baseCls = Class.forName("com.github.copilot.agent.input.CopilotAgentInputPanelBase", false, cl)
            val pieField = baseCls.getDeclaredField("contextUsagePieChart").apply { isAccessible = true }
            val pieChart = pieField.get(inputPanel)
            if (pieChart == null) {
                log.info("readContextWindow: contextUsagePieChart field is null")
                return null
            }

            val pieCls = Class.forName("com.github.copilot.agent.input.ContextUsagePieChart", false, cl)
            val infoField = pieCls.getDeclaredField("contextSizeInfo").apply { isAccessible = true }
            val info = infoField.get(pieChart)
            if (info == null) {
                log.info("readContextWindow: contextSizeInfo field is null (no turn has reported context usage yet)")
                return null
            }

            val infoCls = Class.forName(
                "com.github.copilot.chat.conversation.agent.rpc.message.ContextSizeInfo", false, cl,
            )
            val total = (infoCls.getMethod("getTotalTokenLimit").invoke(info) as Int).toLong()
            val used = (infoCls.getMethod("getTotalUsedTokens").invoke(info) as Int).toLong()
            val pct = (infoCls.getMethod("getUtilizationPercentage").invoke(info) as Double).toInt()
            val sys = (infoCls.getMethod("getSystemPromptTokens").invoke(info) as Int).toLong()
            val tools = (infoCls.getMethod("getToolDefinitionTokens").invoke(info) as Int).toLong()
            val userMsgs = (infoCls.getMethod("getUserMessagesTokens").invoke(info) as Int).toLong()
            val asstMsgs = (infoCls.getMethod("getAssistantMessagesTokens").invoke(info) as Int).toLong()
            val files = (infoCls.getMethod("getAttachedFilesTokens").invoke(info) as Int).toLong()
            val toolResults = (infoCls.getMethod("getToolResultsTokens").invoke(info) as Int).toLong()

            val activeModelName = readActiveModelName(project, cl)

            val breakdown = if (total > 0) mapOf(
                "systemInstructions" to sys.toDouble() / total,
                "toolDefinitions" to tools.toDouble() / total,
                "userMessages" to userMsgs.toDouble() / total,
                "assistantMessages" to asstMsgs.toDouble() / total,
                "attachedFiles" to files.toDouble() / total,
                "toolResults" to toolResults.toDouble() / total,
            ) else emptyMap()

            log.info("readContextWindow: used=$used total=$total pct=$pct model=$activeModelName")
            CopilotContextWindow(
                used = used,
                total = total,
                percent = pct,
                model = activeModelName,
                breakdown = breakdown,
                rateLimitReset = CopilotChatBridge.lastQuotaError,
            )
        } catch (t: Throwable) {
            log.warn("readContextWindow: ${t.javaClass.simpleName}: ${t.message}", t)
            null
        }
    }

    /**
     * `StateFlow.getValue` is declared public in bytecode but Copilot's
     * `DerivedStateFlow` lives in a `kotlin module` that Java reflection
     * trips over (`IllegalAccessException: ... DerivedStateFlow ...
     * "public"`). `setAccessible(true)` bypasses the module check.
     */
    private fun invokeGetValue(flow: Any): Any? {
        val m = flow.javaClass.getMethod("getValue")
        m.isAccessible = true
        return m.invoke(flow)
    }

    private fun readActiveModelName(project: Project, cl: ClassLoader): String? = try {
        val chatSvcCls = Class.forName("com.github.copilot.session.ChatService", false, cl)
        val companion = chatSvcCls.getField("Companion").get(null)
        val chatService = companion.javaClass.getMethod("getInstance", Project::class.java).invoke(companion, project)
        val panelFlow = chatSvcCls.getMethod("getPanelChat").invoke(chatService)
        val chat = invokeGetValue(panelFlow)
        val chatCls = Class.forName("com.github.copilot.session.Chat", false, cl)
        val active = chatCls.getMethod("getActiveSession").invoke(chat)
        val sessionCls = Class.forName("com.github.copilot.session.ChatSession", false, cl)
        val model = sessionCls.getMethod("getModel").invoke(active)
        if (model == null) null else
            Class.forName("com.github.copilot.chat.conversation.agent.rpc.command.CopilotModel", false, cl)
                .getMethod("getModelName").invoke(model) as String?
    } catch (t: Throwable) {
        log.info("readActiveModelName: ${t.javaClass.simpleName}: ${t.message}")
        null
    }

    /** List models available in the chat-panel scope plus the active id. */
    fun listModels(project: Project): CopilotModelList? {
        val cl = copilotClassLoader() ?: run {
            log.info("listModels: Copilot classloader unavailable")
            return null
        }
        return try {
            val svcCls = Class.forName("com.github.copilot.model.CompositeModelService", false, cl)
            val app = ApplicationManager.getApplication()
            val getService = ComponentManager::class.java.getMethod("getService", Class::class.java)
            val svc = getService.invoke(app, svcCls) ?: return null

            val accessor = svcCls.getMethod("getModels").invoke(svc)
            val scopeCls = Class.forName("com.github.copilot.model.ModelScope\$ChatPanel", false, cl)
            val scope = scopeCls.getField("INSTANCE").get(null)
            val flow = accessor.javaClass.getMethod(
                "get", Class.forName("com.github.copilot.model.ModelScope", false, cl),
            ).invoke(accessor, scope)

            @Suppress("UNCHECKED_CAST")
            val models = invokeGetValue(flow) as List<Any>

            val modelCls = Class.forName(
                "com.github.copilot.chat.conversation.agent.rpc.command.CopilotModel", false, cl,
            )
            val all = models.map { m ->
                CopilotModelInfo(
                    id = modelCls.getMethod("getId").invoke(m) as String,
                    label = modelCls.getMethod("getModelName").invoke(m) as String,
                    isDefault = modelCls.getMethod("isChatDefault").invoke(m) as Boolean,
                    family = modelCls.getMethod("getModelFamily").invoke(m) as String?,
                    preview = modelCls.getMethod("getPreview").invoke(m) as Boolean,
                )
            }

            val activeId = try {
                val chatSvcCls = Class.forName("com.github.copilot.session.ChatService", false, cl)
                val companion = chatSvcCls.getField("Companion").get(null)
                val chatService = companion.javaClass.getMethod("getInstance", Project::class.java).invoke(companion, project)
                val panelFlow = chatSvcCls.getMethod("getPanelChat").invoke(chatService)
                val chat = invokeGetValue(panelFlow)
                val chatCls = Class.forName("com.github.copilot.session.Chat", false, cl)
                val active = chatCls.getMethod("getActiveSession").invoke(chat)
                val sessionCls = Class.forName("com.github.copilot.session.ChatSession", false, cl)
                val model = sessionCls.getMethod("getModel").invoke(active)
                if (model != null) modelCls.getMethod("getId").invoke(model) as String? else null
            } catch (_: Throwable) { null }

            log.info("listModels: ${all.size} models, active=$activeId")
            CopilotModelList(activeId, all)
        } catch (t: Throwable) {
            log.warn("listModels: ${t.javaClass.simpleName}: ${t.message}", t)
            null
        }
    }

    /**
     * Switch the active panel-chat model. Dispatches the same redux
     * action Copilot's own model-picker UI fires.
     */
    fun selectModel(project: Project, modelId: String): Boolean {
        val cl = copilotClassLoader() ?: return false
        return try {
            val svcCls = Class.forName("com.github.copilot.model.CompositeModelService", false, cl)
            val app = ApplicationManager.getApplication()
            val getService = ComponentManager::class.java.getMethod("getService", Class::class.java)
            val svc = getService.invoke(app, svcCls)
            val accessor = svcCls.getMethod("getModels").invoke(svc)
            val scopeCls = Class.forName("com.github.copilot.model.ModelScope\$ChatPanel", false, cl)
            val scope = scopeCls.getField("INSTANCE").get(null)
            val flow = accessor.javaClass.getMethod(
                "get", Class.forName("com.github.copilot.model.ModelScope", false, cl),
            ).invoke(accessor, scope)

            @Suppress("UNCHECKED_CAST")
            val models = invokeGetValue(flow) as List<Any>
            val modelCls = Class.forName(
                "com.github.copilot.chat.conversation.agent.rpc.command.CopilotModel", false, cl,
            )
            val wanted = modelId.lowercase()
            // Flexible match: id (exact / case-insensitive),
            // modelFamily (Copilot exposes that as the API id, e.g.
            // "gpt-4.1" / "claude-sonnet-4-5"), or modelName ignoring
            // case + spaces (so "GPT-4o" matches "gpt-4o" / "GPT 4o").
            // Without this the front-end's `gpt-4o` never matches
            // Copilot's `gpt-4.1` even when the family is the same.
            val target = models.firstOrNull { m ->
                val id = (modelCls.getMethod("getId").invoke(m) as String).lowercase()
                val family = (modelCls.getMethod("getModelFamily").invoke(m) as? String)?.lowercase() ?: ""
                val name = (modelCls.getMethod("getModelName").invoke(m) as? String)?.lowercase()?.replace("\\s+".toRegex(), "") ?: ""
                val wantedNoSpace = wanted.replace("\\s+".toRegex(), "")
                id == wanted || family == wanted || name == wantedNoSpace ||
                    id.contains(wanted) || wanted.contains(id) ||
                    family.contains(wanted) || wanted.contains(family)
            } ?: run {
                val available = models.joinToString(", ") {
                    (modelCls.getMethod("getId").invoke(it) as String)
                }
                log.warn("selectModel: '$modelId' not in chat-panel scope. Available: $available")
                return false
            }

            val modelIdCls = Class.forName("com.github.copilot.model.ModelId", false, cl)
            val midCompanion = modelIdCls.getField("Companion").get(null)
            val builder = midCompanion.javaClass.getMethod("forModel", modelCls).invoke(midCompanion, target)
            val newModelId = builder.javaClass.getMethod("byId").invoke(builder)

            val chatSvcCls = Class.forName("com.github.copilot.session.ChatService", false, cl)
            val companion = chatSvcCls.getField("Companion").get(null)
            val chatService = companion.javaClass.getMethod("getInstance", Project::class.java).invoke(companion, project)
            val panelFlow = chatSvcCls.getMethod("getPanelChat").invoke(chatService)
            val chat = invokeGetValue(panelFlow)
            val chatCls = Class.forName("com.github.copilot.session.Chat", false, cl)
            val activeSession = chatCls.getMethod("getActiveSession").invoke(chat) ?: return false
            val sessionCls = Class.forName("com.github.copilot.session.ChatSession", false, cl)
            val sid = sessionCls.getMethod("getId").invoke(activeSession) as String
            val chatType = sessionCls.getMethod("getChatType").invoke(activeSession)
            val chatTypeCls = Class.forName("com.github.copilot.session.Chat\$Type", false, cl)

            val actionCls = Class.forName("com.github.copilot.session.ChatAction\$ModelSelected", false, cl)
            val ctor = actionCls.getConstructor(chatTypeCls, String::class.java, modelIdCls)
            val action = ctor.newInstance(chatType, sid, newModelId)

            chatSvcCls.getMethod("dispatch", Class.forName("com.github.copilot.redux.Action", false, cl))
                .invoke(chatService, action)

            log.info("CopilotChatMetadataBridge: dispatched ModelSelected → $modelId")
            true
        } catch (t: Throwable) {
            log.warn("selectModel: ${t.javaClass.simpleName}: ${t.message}")
            false
        }
    }
}
