package com.windsurf.controller.services

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessHandler
import com.intellij.execution.process.ProcessListener
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.util.Key
import java.util.concurrent.atomic.AtomicReference

/**
 * Attaches a ProcessListener to the Codeium plugin's language-server
 * ProcessHandler so AgentOutputMonitor can read the live JSON-RPC
 * stream Cascade emits — necessary for the agent-response capture
 * when the JCEF panel doesn't expose the rendered HTML through any
 * accessible Swing component.
 *
 * Extracted from AgentOutputMonitor so the 180-LOC reflection
 * intercept doesn't take up a fifth of the monitor's body. All
 * private mutable state (interceptedHandler, processAdapter,
 * processOutputBuffer, attached flag) now lives here.
 *
 * Lifecycle:
 *   - `attach()` — best-effort, looks for the Codeium plugin via
 *     PluginDescriptors + reflects into LanguageServerProcessHandler
 *     for a static field of the ProcessHandler type. No-op when
 *     Codeium isn't installed or the field shape has drifted.
 *   - `readBuffer()` — drains + returns whatever response text was
 *     captured since the last call, or null when the buffer is
 *     empty / the tap isn't attached.
 *   - `detach()` — removes the listener + clears state. Idempotent.
 */
internal class CodeiumProcessTap {

    private val logger = Logger.getInstance(CodeiumProcessTap::class.java)
    private val gson = Gson()

    private var interceptedHandler: ProcessHandler? = null
    private var processAdapter: ProcessListener? = null
    private val processOutputBuffer = StringBuilder()
    @Volatile
    private var attached = false

    fun attach() {
        if (attached) return
        try {
            val codeiumId = PluginId.getId("com.codeium.intellij")
            val descriptor = PluginDescriptors.findById(codeiumId)
            if (descriptor == null) {
                logger.info("Process intercept: Codeium plugin not found")
                return
            }
            val cl = descriptor.pluginClassLoader ?: return
            tryFieldScanForProcessHandler(cl)
        } catch (e: Exception) {
            logger.info("Process intercept setup failed: ${e.message}")
        }
    }

    fun readBuffer(): String? {
        if (!attached) return null
        val text: String
        synchronized(processOutputBuffer) {
            if (processOutputBuffer.isEmpty()) return null
            text = processOutputBuffer.toString()
            processOutputBuffer.clear()
        }
        return extractAgentResponse(text)
    }

    fun detach() {
        try {
            val handler = interceptedHandler
            val adapter = processAdapter
            if (handler != null && adapter != null) {
                handler.removeProcessListener(adapter)
            }
        } catch (e: Exception) { logger.trace(e) }
        interceptedHandler = null
        processAdapter = null
        attached = false
        synchronized(processOutputBuffer) { processOutputBuffer.clear() }
    }

    private fun tryFieldScanForProcessHandler(pluginCL: ClassLoader) {
        try {
            val handlerClass = Class.forName(
                "com.codeium.intellij.language_server.LanguageServerProcessHandler",
                true, pluginCL,
            )
            logger.info("Process intercept: LanguageServerProcessHandler class loaded")

            val allFields = mutableListOf<String>()
            var c: Class<*>? = handlerClass
            while (c != null && c != Any::class.java) {
                for (field in c.declaredFields) {
                    val isStatic = java.lang.reflect.Modifier.isStatic(field.modifiers)
                    allFields.add("${if (isStatic) "static " else ""}${field.type.simpleName} ${field.name}")
                    if (isStatic) {
                        try {
                            field.isAccessible = true
                            val value = field.get(null)
                            if (value is ProcessHandler) {
                                logger.info("Process intercept: found static handler in ${field.name}")
                                attachProcessListener(value)
                                return
                            }
                        } catch (e: Exception) { logger.trace(e) }
                    }
                }
                c = c.superclass
            }
            logger.info("Process intercept: LanguageServerProcessHandler fields: ${allFields.joinToString(", ")}")

            if (ProcessHandler::class.java.isAssignableFrom(handlerClass)) {
                logger.info("Process intercept: LanguageServerProcessHandler IS a ProcessHandler subclass")
            }
        } catch (_: ClassNotFoundException) {
            logger.info("Process intercept: LanguageServerProcessHandler class not found")
        } catch (e: Exception) {
            logger.debug("Process intercept field scan failed: ${e.message}")
        }
    }

    private fun findProcessHandlerInObject(obj: Any, maxDepth: Int, visited: MutableSet<Int>): ProcessHandler? {
        if (maxDepth <= 0) return null
        val id = System.identityHashCode(obj)
        if (id in visited) return null
        visited.add(id)
        if (obj is ProcessHandler) return obj

        if (obj is AtomicReference<*>) {
            val inner = obj.get()
            if (inner is ProcessHandler) return inner
            if (inner != null) return findProcessHandlerInObject(inner, maxDepth - 1, visited)
        }

        try {
            var clazz: Class<*>? = obj.javaClass
            while (clazz != null && clazz != Any::class.java) {
                for (field in clazz.declaredFields) {
                    if (field.type.isPrimitive || field.type == String::class.java
                        || field.type == Boolean::class.javaPrimitiveType
                        || field.type == Int::class.javaPrimitiveType
                        || field.type == Long::class.javaPrimitiveType
                    ) continue
                    try {
                        field.isAccessible = true
                        val value = field.get(obj) ?: continue
                        if (value is ProcessHandler) {
                            logger.info("Process intercept: found handler in ${clazz.name}.${field.name}")
                            return value
                        }
                        if (value is AtomicReference<*>) {
                            val inner = value.get()
                            if (inner is ProcessHandler) {
                                logger.info("Process intercept: found handler in AtomicRef ${clazz.name}.${field.name}")
                                return inner
                            }
                            if (inner != null && maxDepth > 1) {
                                val found = findProcessHandlerInObject(inner, maxDepth - 1, visited)
                                if (found != null) return found
                            }
                        }
                        if (maxDepth > 1
                            && !field.type.isArray
                            && !field.type.name.startsWith("java.lang.")
                            && !field.type.name.startsWith("kotlin.")
                            && !field.type.isEnum
                        ) {
                            val found = findProcessHandlerInObject(value, maxDepth - 1, visited)
                            if (found != null) return found
                        }
                    } catch (e: Exception) { logger.trace(e) }
                }
                clazz = clazz.superclass
            }
        } catch (e: Exception) { logger.trace(e) }
        return null
    }

    private fun attachProcessListener(handler: ProcessHandler) {
        val adapter = object : ProcessListener {
            override fun onTextAvailable(event: ProcessEvent, outputType: Key<*>) {
                val text = event.text ?: return
                if (text.isBlank()) return
                synchronized(processOutputBuffer) {
                    processOutputBuffer.append(text)
                }
            }
        }
        try {
            handler.addProcessListener(adapter)
            interceptedHandler = handler
            processAdapter = adapter
            attached = true
            logger.info("Process intercept: attached listener to ${handler.javaClass.name}")
        } catch (e: Exception) {
            logger.warn("Process intercept: failed to attach listener: ${e.message}")
        }
    }

    private fun extractAgentResponse(raw: String): String? {
        val sb = StringBuilder()
        for (line in raw.lines()) {
            val trimmed = line.trim()
            if (trimmed.isEmpty()) continue
            if (trimmed.startsWith("{") && trimmed.contains("\"jsonrpc\"")) {
                try {
                    val json = gson.fromJson(trimmed, JsonObject::class.java)
                    val params = json.getAsJsonObject("params")
                    if (params != null) {
                        val data = params.get("data")?.asString
                        if (data != null && data.length > 10
                            && !data.contains("MCP")
                            && !data.startsWith("[")
                            && !data.contains("readResponses")
                        ) {
                            sb.appendLine(data)
                        }
                    }
                } catch (e: Exception) { logger.trace(e) }
            } else if (trimmed.length > 20
                && !trimmed.startsWith("2026")
                && !trimmed.contains("INFO")
                && !trimmed.contains("DEBUG")
            ) {
                sb.appendLine(trimmed)
            }
        }
        val result = sb.toString().trim()
        return if (result.length > 10) result else null
    }
}
