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
import com.intellij.openapi.wm.ToolWindowManager
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
     * The chat-related classes (`ChatSessionStorage`, `ChatSession`,
     * `ChatMessage`) live in the `intellij.ml.llm.chat` sub-module,
     * which has its own classloader separate from the main plugin
     * loader. `plugin.pluginClassLoader` does NOT see them — that's
     * why straight `Class.forName(..., pluginClassLoader)` blew up
     * with `ClassNotFoundException: ChatSessionStorage` and the
     * extractor fell back to the Swing scrape (which aplanated the
     * markdown table into one cell per line).
     *
     * Workaround: find the live `AIAssistantInputEditorTextField` in
     * the AIAssistant tool window and use ITS classloader. That
     * component is loaded by the chat sub-module's loader, so its
     * loader sees every chat-related class. Cache the discovered
     * loader so subsequent polls don't need to re-walk the tree.
     */
    @Volatile
    private var cachedChatModuleLoader: ClassLoader? = null

    private fun chatModuleClassLoader(project: Project): ClassLoader? {
        cachedChatModuleLoader?.let { return it }
        val tw = try {
            ToolWindowManager.getInstance(project).getToolWindow("AIAssistant")
        } catch (_: Exception) { null } ?: return null
        val input = findInputEditorTextField(tw) ?: return null
        val cl = input.javaClass.classLoader
        cachedChatModuleLoader = cl
        return cl
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
     * The string returned is whatever the assistant-side ChatMessage
     * exposes as its canonical text — preferentially the markdown
     * `MarkdownChatMessage.getDisplayText()` returns. The chat panel
     * renders that markdown to HTML, so it has tables, code fences,
     * lists intact — exactly what the mobile/web renderer needs to
     * produce its rich custom components.
     */
    fun readLatestAssistantMessage(project: Project): String? {
        val cl = chatModuleClassLoader(project) ?: pluginClassLoader() ?: return null
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

            // One-line dump of the session topology so we can see what
            // subtypes the chat is holding and where the real text lives.
            // RestoredMessage in this Codex build returns empty
            // displayText/text — the canonical markdown is presumably in
            // a SimpleCompletableMessage further up the list, or in a
            // ChunkedTextStorage field we need to dig into. The dump
            // catches both.
            log.info("AIAssistantBridge: session has ${messages.size} message(s)")
            for ((idx, msg) in messages.withIndex()) {
                val author = try { msg.javaClass.getMethod("getAuthor").invoke(msg)?.toString() } catch (_: Exception) { "?" }
                val displayPreview = try {
                    val v = msg.javaClass.getMethod("getDisplayText").invoke(msg)
                    if (v == null) "null" else {
                        val s = unwrapToString(v)
                        if (s.isNullOrBlank()) "<blank>" else "[${s.length}]${s.take(60).replace("\n", "\\n")}"
                    }
                } catch (_: Exception) { "<no-getter>" }
                val textPreview = try {
                    val v = msg.javaClass.getMethod("getText").invoke(msg)
                    if (v == null) "null" else {
                        val s = unwrapToString(v)
                        if (s.isNullOrBlank()) "<blank>" else "[${s.length}]${s.take(60).replace("\n", "\\n")}"
                    }
                } catch (_: Exception) { "<no-getter>" }
                // Peek into a ChunkedTextStorage field if present (live
                // SimpleCompletableMessage stores streaming text here).
                val storagePreview = run {
                    var c: Class<*>? = msg.javaClass
                    var found: String? = null
                    while (c != null && c != Any::class.java && found == null) {
                        for (f in c.declaredFields) {
                            if (f.type.simpleName == "ChunkedTextStorage") {
                                f.isAccessible = true
                                val st = f.get(msg) ?: continue
                                val gt = try { st.javaClass.getMethod("getText").invoke(st) } catch (_: Exception) { null }
                                val s = if (gt != null) unwrapToString(gt) else null
                                found = if (s.isNullOrBlank()) "<blank>" else "[${s.length}]${s.take(60).replace("\n", "\\n")}"
                                break
                            }
                        }
                        c = c.superclass
                    }
                    found ?: "<no-storage>"
                }
                log.info("  msg[$idx] cls=${msg.javaClass.simpleName} author=$author display=$displayPreview text=$textPreview storage=$storagePreview")
            }

            // Walk in reverse for the last assistant message. The
            // ChatMessageAuthor enum has Assistant + User variants;
            // we identify by the simple name of the author class /
            // toString since the exact type isn't on our classpath.
            val msgCls = Class.forName(
                "com.intellij.ml.llm.core.chat.messages.ChatMessage", false, cl,
            )
            // Walk in reverse looking for the most recent NON-user
            // message with non-blank text. AI Assistant + Codex use
            // different author label conventions ("Assistant", "AI",
            // "Codex", "System", "Bot", …); we only know the user
            // side reliably so we skip "user" / "human" and accept
            // anything else. The text guard inside readMessageText
            // already filters out non-text payloads.
            for (i in messages.indices.reversed()) {
                val msg = messages[i]
                val author = try {
                    msgCls.getMethod("getAuthor").invoke(msg)
                } catch (_: Exception) { null }
                val authorStr = author?.toString()?.lowercase() ?: ""
                if ("user" in authorStr || "human" in authorStr) continue
                val text = readMessageText(msg, msgCls)
                if (!text.isNullOrBlank()) {
                    // One-line diagnostic so we can confirm in the IDE log
                    // which subtype + getter produced the canonical
                    // markdown for this build (the Codex variant may use a
                    // different ChatMessage subtype than the standard AI
                    // Assistant build). Logged only when we have a value
                    // so it doesn't spam during empty polls.
                    log.info(
                        "AIAssistantBridge: msg class=${msg.javaClass.name} author=$authorStr len=${text.length} preview=${text.take(60).replace("\n", "\\n")}",
                    )
                    return text
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
    /**
     * Non-text accessors we know not to call. They either return
     * non-text (`getChat`/`getSession`/`getAuthor`/`getRole`/`getKind`/
     * `getType`/`getStatus`), an id (`getUid`/`getId`), a timestamp
     * (`getCreated*`/`getTimestamp`), or trigger a heavy operation we
     * don't want as a side effect. The previous version's bug was
     * exactly this: the fallback walker called `getChat()` and used
     * its `toString()` as the message body, so mobile saw
     * `ChatSessionImpl@…` and then `getUid()` (a 36-char UUID).
     */
    private val NON_TEXT_GETTERS = setOf(
        "getUid", "getId", "getCreatedAt", "getCreated", "getTimestamp", "getClass",
        "getAuthor", "getChat", "getSession", "getRole", "getStatus", "getKind", "getType",
        "getReferences", "getReferencedFiles", "getAttachments", "getTools",
        "getMetadata", "getMeta", "getProperties", "getProperty", "getProject",
    )

    /**
     * Find the canonical markdown text on a ChatMessage by:
     *  1. Probing the known good getter names first
     *     (`getDisplayText` / `getMarkdownText` / …) so the happy path
     *     is unchanged on builds where they exist.
     *  2. If nothing markdown-structured turned up, enumerating ALL
     *     no-arg getters on the message's runtime class and picking
     *     the one whose return value looks most like markdown — fences,
     *     pipe-and-dash table delimiters, list markers, headings.
     *
     * The heuristic is the important part for the Codex build: AI
     * Assistant ships several message subtypes
     * (`MarkdownChatMessage`, `CodexChatMessage`, `RichTextChatMessage`,
     * …) and the JAR a given user has installed determines which one
     * holds the assistant's reply. Hardcoding getter names broke each
     * time a new subtype shipped; pattern-matching the *content* keeps
     * working as long as one of the getters returns the raw markdown
     * the chat panel renders.
     *
     * Returns null if nothing on the message looks like markdown — in
     * that case the streaming Swing snapshot wins (plain-text replies
     * like "Hola, ¿en qué te ayudo?" naturally fall into this bucket
     * and we don't want a wrong getter clobbering them).
     */
    private fun readMessageText(msg: Any, msgCls: Class<*>): String? {
        val candidates = listOf(
            "getDisplayText",
            "getMarkdownText",
            "getMarkdown",
            "getRawMarkdown",
            "getRaw",
            "getRawText",
            "getContent",
            "getMessageText",
            "getText",
        )
        val markdownCls = try {
            Class.forName(
                "com.intellij.ml.llm.core.chat.messages.MarkdownChatMessage",
                false, msg.javaClass.classLoader,
            )
        } catch (_: Exception) { null }

        // Phase 1: gather every text value reachable via known +
        // heuristic getters. We collect ALL of them (not first-non-null)
        // so we can then prefer the one with markdown structure.
        //
        // Order matters: query the runtime class FIRST. RestoredMessage
        // (and similar concrete subtypes) declare `getDisplayText()`
        // directly even though the `ChatMessage` interface only has
        // `getText()`. If we only probed the interface we'd miss
        // `getDisplayText` entirely on RestoredMessage and never see
        // the canonical markdown.
        val collected = LinkedHashMap<String, String>()
        fun tryGetter(clazz: Class<*>, name: String, label: String) {
            val method = try { clazz.getMethod(name) } catch (_: NoSuchMethodException) { return }
            catch (e: Exception) {
                log.info("tryGetter $label: getMethod threw ${e.javaClass.simpleName}: ${e.message}")
                return
            }
            val v = try { method.invoke(msg) } catch (e: Exception) {
                log.info("tryGetter $label: invoke threw ${e.javaClass.simpleName}: ${e.message}")
                return
            }
            if (v == null) {
                log.info("tryGetter $label: returned null")
                return
            }
            val s = unwrapToString(v)
            if (s.isNullOrBlank() || s.length < 2) {
                log.info("tryGetter $label: unwrap returned ${if (s == null) "null" else "blank/short(${s.length})"}")
                return
            }
            collected.putIfAbsent(label, s)
        }
        for (n in candidates) tryGetter(msg.javaClass, n, "${msg.javaClass.simpleName}.$n")
        if (markdownCls != null && markdownCls.isInstance(msg)) {
            for (n in candidates) tryGetter(markdownCls, n, "MarkdownChatMessage.$n")
        }
        for (n in candidates) tryGetter(msgCls, n, "ChatMessage.$n")

        // Phase 1.5: ChunkedTextStorage path. SimpleCompletableMessage
        // (the live streaming subtype) accumulates text into a
        // private `textStorage: ChunkedTextStorage` field whose
        // `getText()` returns the canonical PSString. Walk the class
        // hierarchy looking for any field of that type and try its
        // getText().
        run {
            var c: Class<*>? = msg.javaClass
            while (c != null && c != Any::class.java) {
                for (f in c.declaredFields) {
                    if (f.type.simpleName != "ChunkedTextStorage") continue
                    try {
                        f.isAccessible = true
                        val storage = f.get(msg) ?: continue
                        val v = try { storage.javaClass.getMethod("getText").invoke(storage) } catch (_: Exception) { continue }
                        val s = unwrapToString(v ?: continue) ?: continue
                        if (s.length >= 2) {
                            collected.putIfAbsent("ChunkedTextStorage.${f.name}.getText", s)
                            log.info("ChunkedTextStorage hit: ${msg.javaClass.simpleName}.${f.name} → ${s.length} chars")
                        }
                    } catch (e: Exception) {
                        log.info("ChunkedTextStorage on ${msg.javaClass.simpleName}.${f.name} threw ${e.javaClass.simpleName}: ${e.message}")
                    }
                }
                c = c.superclass
            }
        }

        // Phase 2: if none of the named getters returned markdown-
        // structured text, enumerate every no-arg getter on the
        // runtime class and add anything new. This is the Codex
        // safety net: it catches getters with build-specific names
        // (`getBody`, `getResponseMarkdown`, `getAssistantText`, …)
        // we couldn't predict ahead of time.
        val haveStructure = collected.values.any { hasMarkdownStructure(it) }
        if (!haveStructure) {
            for (method in msg.javaClass.methods) {
                if (method.parameterCount != 0) continue
                val name = method.name
                if (!name.startsWith("get")) continue
                if (name in NON_TEXT_GETTERS) continue
                if (collected.keys.any { it.endsWith(".$name") }) continue
                val v = try { method.invoke(msg) } catch (_: Exception) { null } ?: continue
                val s = unwrapToString(v) ?: continue
                if (s.isBlank() || s.length < 5) continue
                collected["heuristic.$name"] = s
            }
        }

        if (collected.isEmpty()) {
            log.info("AIAssistantBridge: no text getters returned a value on ${msg.javaClass.name}")
            return null
        }

        // Log every candidate so when this ever picks wrong we can
        // diagnose from the user's IDE log without another rebuild.
        for ((label, s) in collected) {
            val kind = describeKind(s)
            log.info("AIAssistantBridge: cand=$label kind=$kind len=${s.length} preview=${s.take(80).replace("\n", "\\n")}")
        }

        // Pick order:
        //   1. markdown-structured (fence / table / list / heading) — longest wins
        //   2. multi-line text — longest wins
        //   3. nothing else; return null and let streaming hold
        val structured = collected.entries.filter { hasMarkdownStructure(it.value) }
        if (structured.isNotEmpty()) {
            val best = structured.maxBy { it.value.length }
            log.info("AIAssistantBridge: chose markdown-structured ${best.key}")
            return best.value
        }
        val multiline = collected.entries.filter { it.value.contains("\n") }
        if (multiline.isNotEmpty()) {
            val best = multiline.maxBy { it.value.length }
            log.info("AIAssistantBridge: chose multi-line ${best.key}")
            return best.value
        }
        // Single-line short reply (e.g. "Hola, ¿en qué te ayudo?"). The
        // streaming Swing scrape already captures these reliably — do
        // NOT return a single-line string from the heuristic pool, it
        // might be a wrong getter (label, button text, etc.). The
        // streaming snapshot wins.
        log.info("AIAssistantBridge: no markdown / multi-line candidate; deferring to streaming snapshot")
        return null
    }

    /**
     * Markdown structure markers: GFM tables (`|` row delimiters with
     * a `---` divider row), fenced code blocks (```), ATX headings
     * (`# `, `## `, …) at the start of a line, list markers (`- `,
     * `* `, `1. `). Anything matching one of these is "structured
     * enough" to prefer over a flattened streaming snapshot.
     */
    private fun hasMarkdownStructure(s: String): Boolean {
        if (s.contains("```")) return true
        if (s.contains("|") && s.contains("---")) return true
        if (Regex("(?m)^#{1,6} ").containsMatchIn(s)) return true
        if (Regex("(?m)^\\s*[-*] ").containsMatchIn(s)) return true
        if (Regex("(?m)^\\s*\\d+\\. ").containsMatchIn(s)) return true
        return false
    }

    private fun describeKind(s: String): String = when {
        s.contains("```") -> "fenced-code"
        s.contains("|") && s.contains("---") -> "table"
        Regex("(?m)^#{1,6} ").containsMatchIn(s) -> "heading"
        Regex("(?m)^\\s*[-*] ").containsMatchIn(s) -> "bulleted"
        s.contains("\n") -> "multi-line"
        else -> "single-line"
    }

    /**
     * Pull a String out of a value IFF it is genuinely a text type.
     *
     * Order:
     *  1. `PrivacySafe.unwrap()` — `PSString` and friends wrap a
     *     String; `toString()` on these wrappers is build-specific
     *     (some builds mask the content for logging), `unwrap()` is
     *     documented to return the raw inner `T`. Prefer it so we
     *     get markdown with `|`, `---`, fences preserved.
     *  2. Plain `String` or `CharSequence`.
     *
     * Anything else (a ChatSession, a list, an enum) returns null.
     * The previous version defaulted to `Object.toString()`, which
     * is why the mobile UI saw
     * `com.intellij.ml.llm.core.chat.session.impl.ChatSessionImpl@54c89a2e`
     * — the fallback getter walk hit `getChat()` and accepted its
     * `toString()` as if it were the message body.
     */
    private fun unwrapToString(v: Any): String? {
        // PrivacySafe<T : CharSequence> implements CharSequence directly
        // (verified from bytecode), and PrivacySafe.toString() simply
        // delegates to its `contents` field's toString() — i.e. it
        // returns the raw inner String. So three independent paths can
        // produce the markdown:
        //
        //   A) Read the private `contents` field directly. Most robust;
        //      bypasses any potential security/visibility wrapping.
        //   B) Call unwrap() via reflection — the documented accessor.
        //   C) Treat v as CharSequence and call toString().
        //
        // We try A → B → C. If a PSString reaches us and all three
        // return null/blank, we log enough to diagnose without rebuilding.
        // The previous version only did B → (limited) C and was returning
        // null on RestoredMessage, which is why the canonical-final
        // chunk never emitted: getText() / getDisplayText() *were* being
        // invoked, the PSString was reaching unwrapToString, but
        // unwrap() reflection apparently failed silently (bridge-method
        // ambiguity is the leading suspect) and the CharSequence
        // fallback didn't trigger because some intermediate catch
        // returned early.
        val cls = v.javaClass
        // Path A: private `contents` field on PrivacySafe.
        try {
            var c: Class<*>? = cls
            while (c != null && c != Any::class.java) {
                val f = try { c.getDeclaredField("contents") } catch (_: NoSuchFieldException) { null }
                if (f != null) {
                    f.isAccessible = true
                    val inner = f.get(v)
                    if (inner is String && inner.isNotBlank()) {
                        log.info("unwrapToString A/contents: ${cls.simpleName} → String[${inner.length}]")
                        return inner
                    }
                    if (inner is CharSequence) {
                        val s = inner.toString()
                        if (s.isNotBlank()) {
                            log.info("unwrapToString A/contents: ${cls.simpleName} → CharSequence[${s.length}]")
                            return s
                        }
                    }
                    log.info("unwrapToString A/contents: ${cls.simpleName} → ${inner?.javaClass?.simpleName ?: "null"} (rejected)")
                    break
                }
                c = c.superclass
            }
        } catch (e: Exception) {
            log.info("unwrapToString A/contents: ${cls.name} threw ${e.javaClass.simpleName}: ${e.message}")
        }
        // Path B: reflective unwrap().
        try {
            val m = cls.getMethod("unwrap")
            val inner = m.invoke(v)
            if (inner is String && inner.isNotBlank()) {
                log.info("unwrapToString B/unwrap: ${cls.simpleName} → String[${inner.length}]")
                return inner
            }
            if (inner is CharSequence) {
                val s = inner.toString()
                if (s.isNotBlank()) {
                    log.info("unwrapToString B/unwrap: ${cls.simpleName} → CharSequence[${s.length}]")
                    return s
                }
            }
        } catch (_: NoSuchMethodException) { /* not a PrivacySafe wrapper */ }
          catch (e: Exception) {
            log.info("unwrapToString B/unwrap: ${cls.name} threw ${e.javaClass.simpleName}: ${e.message}")
        }
        // Path C: CharSequence / String surface.
        if (v is CharSequence) {
            val s = v.toString()
            if (s.isNotBlank()) {
                log.info("unwrapToString C/CharSequence: ${cls.simpleName} → String[${s.length}]")
                return s
            }
        }
        if (v is String && v.isNotBlank()) return v
        log.info("unwrapToString: ALL paths returned null for ${cls.name} (isCharSeq=${v is CharSequence})")
        return null
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
        } catch (e: Exception) { log.trace(e) }
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
