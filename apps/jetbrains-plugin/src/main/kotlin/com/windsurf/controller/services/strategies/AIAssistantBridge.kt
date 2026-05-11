package com.windsurf.controller.services.strategies

import com.intellij.ide.DataManager
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ex.ActionUtil
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.components.ComponentManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.editor.Document
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import java.awt.Component
import java.awt.Container

/**
 * Programmatic bridge to the JetBrains AI Assistant plugin
 * (`com.intellij.ml.llm`, tool window `AIAssistant`).
 *
 * Send path: locate the `AIAssistantInputEditorTextField`, replace its
 * document content via a write action (NOT `setText`, which on this
 * specific `EditorTextField` subclass appends instead of replacing —
 * that was the `holaholahola…` bug), then invoke the registered action
 * `AIAssistant.Chat.SendActions.Send` by id. This is exactly the path
 * Copilot uses for its `ChatAction.ModelSelected`: ride the action
 * registry instead of clicking buttons.
 *
 * Read path: `ChatSessionStorage` is a project service that holds the
 * active ChatSession list and currentChatIndex (private field, read
 * via reflection). The last `ChatMessage` whose author is the
 * assistant is the latest reply.
 *
 * Verified against `intellij.ml.llm.chat.jar` extracted from
 * `~/Library/Application Support/JetBrains/WebStorm2026.1/plugins/ml-llm/`
 * (May 2026 build).
 */
internal object AIAssistantBridge {
    private val log = Logger.getInstance(AIAssistantBridge::class.java)
    private val PLUGIN_ID = PluginId.getId("com.intellij.ml.llm")

    private fun pluginClassLoader(): ClassLoader? {
        val plugin = PluginManagerCore.getPlugin(PLUGIN_ID) ?: return null
        if (!plugin.isEnabled) return null
        return plugin.pluginClassLoader
    }

    /**
     * Submit `prompt` into the AI Assistant chat. Caller MUST have
     * already activated the tool window so the input field is mounted.
     * Returns true if both the document replace and the send action
     * fired successfully.
     */
    fun submit(project: Project, prompt: String, tw: ToolWindow): Boolean {
        return try {
            val input = findInputEditorTextField(tw)
            if (input == null) {
                log.warn("AIAssistantBridge: AIAssistantInputEditorTextField not found in tool window")
                return false
            }

            // Replace the document content on EDT inside a write
            // action. `EditorTextField.setText` in this build proxies
            // to `document.insertString(0, s)` which APPENDS — that's
            // why the previous strategy ended up with `holahola...`.
            val replaced = ApplicationManager.getApplication().let { app ->
                val resultRef = arrayOf(false)
                val task = Runnable {
                    try {
                        val doc = readDocument(input)
                        if (doc != null) {
                            WriteCommandAction.runWriteCommandAction(project) {
                                doc.replaceString(0, doc.textLength, prompt)
                            }
                            resultRef[0] = true
                        }
                    } catch (e: Exception) {
                        log.warn("AIAssistantBridge: document replace failed: ${e.message}")
                    }
                }
                if (app.isDispatchThread) task.run() else app.invokeAndWait(task)
                resultRef[0]
            }
            if (!replaced) return false

            // Invoke the registered Send action by id, anchored at the
            // input component. Asking DataManager for the context
            // anchored at that Swing component fills in PROJECT,
            // EDITOR, and everything else the action's `update()`
            // method reads at the `AIAssistantChatInputRight` place.
            // Passing `DataContext { null }` (the previous attempt)
            // left the action disabled, which is why the input kept
            // its text after the notification fired.
            ApplicationManager.getApplication().invokeLater {
                try {
                    val action = ActionManager.getInstance().getAction("AIAssistant.Chat.SendActions.Send")
                    if (action == null) {
                        log.warn("AIAssistantBridge: action AIAssistant.Chat.SendActions.Send not found")
                        return@invokeLater
                    }
                    val component = input as? java.awt.Component
                    val dataContext = if (component != null) {
                        DataManager.getInstance().getDataContext(component)
                    } else {
                        DataManager.getInstance().getDataContextFromFocus().resultSync
                    }
                    val place = "AIAssistantChatInputRight"
                    ActionUtil.invokeAction(action, dataContext, place, null, null)
                    log.info("AIAssistantBridge: invoked AIAssistant.Chat.SendActions.Send at $place")
                } catch (e: Exception) {
                    log.warn("AIAssistantBridge: invokeAction failed: ${e.message}")
                }
            }
            true
        } catch (t: Throwable) {
            log.warn("AIAssistantBridge.submit: ${t.javaClass.simpleName}: ${t.message}")
            false
        }
    }

    /**
     * Read the most recent assistant `ChatMessage.text` from the
     * project's active ChatSession. Returns null if no AI Assistant
     * session exists yet or no assistant reply is present.
     *
     * Plain text is what the mobile/web renderer expects — markdown
     * fences in `ChatMessage` content are already part of the string
     * so they pass through as-is.
     */
    fun readLatestAssistantMessage(project: Project): String? {
        val cl = pluginClassLoader() ?: return null
        return try {
            val storageCls = Class.forName(
                "com.intellij.ml.llm.core.chat.session.ChatSessionStorage", false, cl,
            )
            val getService = ComponentManager::class.java.getMethod("getService", Class::class.java)
            val storage = getService.invoke(project, storageCls) ?: return null

            @Suppress("UNCHECKED_CAST")
            val sessions = storageCls.getMethod("getChatSessions").invoke(storage) as List<Any>
            if (sessions.isEmpty()) return null

            val currentIndex = try {
                val f = storageCls.getDeclaredField("currentChatIndex").apply { isAccessible = true }
                (f.get(storage) as Int).coerceIn(0, sessions.size - 1)
            } catch (_: Exception) {
                sessions.lastIndex
            }
            val session = sessions[currentIndex]

            val sessionCls = Class.forName(
                "com.intellij.ml.llm.core.chat.session.ChatSession", false, cl,
            )
            @Suppress("UNCHECKED_CAST")
            val messages = sessionCls.getMethod("getMessages").invoke(session) as List<Any>
            if (messages.isEmpty()) return null

            // Walk in reverse for the last assistant message. The
            // ChatMessageAuthor enum has Assistant + User variants;
            // we identify by the simple name of the author class /
            // toString since the exact type isn't on our classpath.
            val msgCls = Class.forName(
                "com.intellij.ml.llm.core.chat.messages.ChatMessage", false, cl,
            )
            for (i in messages.indices.reversed()) {
                val msg = messages[i]
                val author = try {
                    msgCls.getMethod("getAuthor").invoke(msg)
                } catch (_: Exception) { null }
                val authorStr = author?.toString()?.lowercase() ?: ""
                if (authorStr.contains("assistant") || authorStr.contains("ai") || authorStr.contains("system")) {
                    val text = readMessageText(msg, msgCls)
                    if (!text.isNullOrBlank()) return text
                }
            }
            null
        } catch (t: Throwable) {
            log.warn("AIAssistantBridge.readLatestAssistantMessage: ${t.javaClass.simpleName}: ${t.message}")
            null
        }
    }

    /**
     * Pull text out of a ChatMessage. Different message subtypes
     * expose the content via different methods (`getText`, `getRaw`,
     * `getContent`, `getMessageText`); we try the common ones until
     * one returns a non-empty CharSequence.
     */
    private fun readMessageText(msg: Any, msgCls: Class<*>): String? {
        val candidates = listOf("getText", "getMessageText", "getContent", "getRaw", "getMarkdown", "getDisplayText")
        for (name in candidates) {
            val v = try { msgCls.getMethod(name).invoke(msg) } catch (_: Exception) { null }
            if (v != null) {
                val s = when (v) {
                    is CharSequence -> v.toString()
                    else -> v.toString()
                }
                if (s.isNotBlank()) return s
            }
        }
        // Fallback: walk all no-arg getters that return a CharSequence
        // descendant or a class named PSString and pick the longest.
        var best: String? = null
        for (m in msgCls.methods) {
            if (m.parameterCount != 0) continue
            if (!m.name.startsWith("get")) continue
            val v = try { m.invoke(msg) } catch (_: Exception) { null } ?: continue
            val s = v.toString()
            if (s.length > (best?.length ?: 0) && s.length < 50_000) best = s
        }
        return best
    }

    private fun findInputEditorTextField(tw: ToolWindow): Any? {
        val ref = arrayOfNulls<Any>(1)
        val app = ApplicationManager.getApplication()
        val task = Runnable {
            val roots: List<Component> = tw.contentManager.contents
                .map { it.component }
                .ifEmpty { listOfNotNull(tw.component) }
            for (root in roots) {
                walkForInput(root, ref)
                if (ref[0] != null) return@Runnable
            }
        }
        if (app.isDispatchThread) task.run() else try {
            app.invokeAndWait(task)
        } catch (_: Exception) {}
        return ref[0]
    }

    private fun walkForInput(c: Component, ref: Array<Any?>) {
        if (ref[0] != null) return
        if (c.javaClass.name == "com.intellij.ml.llm.core.chat.ui.chat.input.AIAssistantInputEditorTextField") {
            ref[0] = c
            return
        }
        if (c is Container) {
            for (i in 0 until c.componentCount) walkForInput(c.getComponent(i), ref)
        }
    }

    /**
     * Pull the live `Document` out of an EditorTextField via the
     * standard `getDocument()` accessor that all subclasses expose
     * (defined on `EditorTextField` in the IntelliJ Platform).
     */
    private fun readDocument(editorTextField: Any): Document? {
        return try {
            val m = editorTextField.javaClass.getMethod("getDocument")
            m.invoke(editorTextField) as? Document
        } catch (_: Exception) { null }
    }
}
