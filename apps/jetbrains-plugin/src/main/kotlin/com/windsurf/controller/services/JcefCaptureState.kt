package com.windsurf.controller.services

import com.intellij.openapi.diagnostic.Logger
import java.lang.reflect.Proxy
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Encapsulates the JCEF capture lifecycle that AgentOutputMonitor
 * used to drive inline through a fan-out of AtomicReferences:
 *
 *   - the captured text / HTML / response-text snapshots, written
 *     by the CefDisplayHandler proxy on `onConsoleMessage`
 *   - the synchronization latch the monitor's orchestrator awaits
 *     for synchronous "capture this frame" calls
 *   - the once-only console-handler proxy install (plus the
 *     reference to the original handler so we can restore it on
 *     cleanup)
 *
 * The previous loopback HTTP capture server (`ensureCaptureServer`)
 * and its `capturePort` field were dead code — defined but never
 * called and no consumer read the port. Removed during this
 * extraction; the Cascade JS injection uses `console.log` exclusively
 * which routes through the CefDisplayHandler proxy below.
 *
 * Public lifecycle:
 *   - `stop()` — restores the original CefDisplayHandler.
 *     Idempotent. Called from AgentOutputMonitor.stopMonitoring.
 *   - `resetSnapshotsForNewTurn()` — clears the HTML/response refs
 *     at the start of a new monitoring turn.
 *   - `setupCapture(browser)` — installs the proxy if needed + fires
 *     the Cascade JS injection that drives the snapshots.
 *   - `awaitText(timeout, unit)` — waits on the latch + returns the
 *     captured text.
 *   - `consumeHtml()` — drains the HTML ref (caller takes ownership;
 *     the ref is cleared on read).
 *   - `consumeResponseText()` — peeks the response-text ref (caller
 *     reads non-destructively, matching the previous inline usage
 *     in `extractResponseSnapshot`).
 */
internal class JcefCaptureState {

    private val logger = Logger.getInstance(JcefCaptureState::class.java)

    private val textRef = AtomicReference<String?>(null)
    private val htmlRef = AtomicReference<String?>(null)
    private val responseTextRef = AtomicReference<String?>(null)
    private val latch = AtomicReference<CountDownLatch?>(null)

    @Volatile private var consoleHandlerInstalled = false
    private var originalDisplayHandler: Any? = null
    private var cefClient: Any? = null

    fun stop() {
        latch.set(null)
        textRef.set(null)
        htmlRef.set(null)
        responseTextRef.set(null)
        cleanupConsoleHandler()
    }

    /** Clear snapshot refs at the start of a fresh monitoring turn. */
    fun resetSnapshotsForNewTurn() {
        htmlRef.set(null)
        responseTextRef.set(null)
    }

    /**
     * Wait up to `timeout` for the proxy to set the text snapshot.
     * Returns the captured text (trimmed) on success, null on
     * timeout. Does NOT clear the snapshot — the monitor's
     * orchestrator decides whether to consume it.
     */
    fun awaitText(timeout: Long, unit: TimeUnit): String? {
        val l = latch.get() ?: return null
        return if (l.await(timeout, unit)) textRef.get()?.trim()?.takeIf { it.isNotBlank() } else null
    }

    fun consumeHtml(): String? {
        val html = htmlRef.get()
        htmlRef.set(null)
        return html
    }

    fun consumeResponseText(): String? = responseTextRef.get()

    /**
     * Install the CefDisplayHandler proxy (once per JCEF lifetime)
     * and fire the Cascade JS injection. The proxy listens for
     * `__CAGENT__:`, `__CAGENT_HTML__:`, `__CAGENT_RESPONSE__:`, and
     * `__CAGENT_DOM__:` console.log prefixes, routes each to the
     * matching AtomicReference snapshot, and counts down the latch
     * on the first text snapshot.
     */
    fun setupCapture(browser: Any) {
        try {
            val platformCL = browser.javaClass.classLoader
            val jbCefBaseClass = Class.forName("com.intellij.ui.jcef.JBCefBrowserBase", true, platformCL)
            val cefBrowser = jbCefBaseClass.getMethod("getCefBrowser").invoke(browser) ?: return
            val jcefCL = cefBrowser.javaClass.classLoader
            val cefBrowserIface = Class.forName("org.cef.browser.CefBrowser", true, jcefCL)

            val newLatch = CountDownLatch(1)
            latch.set(newLatch)
            textRef.set(null)

            if (!consoleHandlerInstalled) {
                installConsoleHandlerProxy(browser, jbCefBaseClass, jcefCL)
            }

            // Execute JS to capture body text + attempt HTML capture of response elements.
            // Use CefFrame interface (exported) instead of concrete RemoteFrame class
            // (non-exported module). Only the Cascade/Windsurf path uses JCEF; agents
            // with their own MessageExtractor (Copilot, AI Assistant) never reach this.
            val cefFrameIface = Class.forName("org.cef.browser.CefFrame", true, jcefCL)
            val mainFrame = cefBrowserIface.getMethod("getMainFrame").invoke(cefBrowser)
            if (mainFrame != null) {
                val execMethod = cefFrameIface.getMethod(
                    "executeJavaScript", String::class.java, String::class.java, Int::class.javaPrimitiveType,
                )
                execMethod.invoke(mainFrame, CASCADE_INJECTION_JS, "about:blank", 0)
                logger.debug("JCEF: JS executed (console capture)")
            } else {
                logger.debug("JCEF: mainFrame is null")
            }
        } catch (e: Exception) {
            logger.warn("JCEF capture failed: ${e.message}")
        }
    }

    private fun installConsoleHandlerProxy(browser: Any, jbCefBaseClass: Class<*>, jcefCL: ClassLoader) {
        try {
            val jbCefClient = jbCefBaseClass.getMethod("getJBCefClient").invoke(browser)
            val client = jbCefClient.javaClass.getMethod("getCefClient").invoke(jbCefClient)
            cefClient = client

            val cefDisplayHandlerClass = Class.forName("org.cef.handler.CefDisplayHandler", true, jcefCL)

            // Preserve existing handler so we can delegate and restore later
            val getHandlerMethod = client.javaClass.methods.find { it.name == "getDisplayHandler" }
            val existingHandler = getHandlerMethod?.invoke(client)
            originalDisplayHandler = existingHandler

            val proxy = Proxy.newProxyInstance(jcefCL, arrayOf(cefDisplayHandlerClass)) { _, method, args ->
                val methodArgs = args ?: emptyArray<Any>()
                if (method.name == "onConsoleMessage") {
                    // Signature: onConsoleMessage(CefBrowser, LogSeverity, String msg, String src, int line)
                    val message = methodArgs.getOrNull(2) as? String
                    if (message != null) {
                        routeConsoleMessage(message)
                    }
                    if (existingHandler != null) {
                        try { return@newProxyInstance method.invoke(existingHandler, *methodArgs) }
                        catch (e: Exception) { logger.trace(e) }
                    }
                    return@newProxyInstance false
                }
                // Delegate all non-Object methods to original handler
                if (existingHandler != null && method.declaringClass != Any::class.java) {
                    try { return@newProxyInstance method.invoke(existingHandler, *methodArgs) }
                    catch (e: Exception) { logger.trace(e) }
                }
                when (method.returnType) {
                    Boolean::class.javaPrimitiveType -> false
                    else -> null
                }
            }

            val addMethod = client.javaClass.methods.find {
                it.name == "addDisplayHandler" && it.parameterCount == 1
            }
            if (addMethod != null) {
                addMethod.invoke(client, proxy)
                consoleHandlerInstalled = true
                logger.info("JCEF: CefDisplayHandler proxy installed (console message capture)")
            } else {
                logger.info("JCEF: addDisplayHandler method not found on ${client.javaClass.name}")
            }
        } catch (e: Exception) {
            logger.info("JCEF: Console handler setup failed: ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    private fun routeConsoleMessage(message: String) {
        when {
            message.startsWith("__CAGENT__:") -> {
                val text = message.removePrefix("__CAGENT__:")
                if (text.length > 5) {
                    textRef.set(text)
                    latch.get()?.countDown()
                    logger.debug("JCEF console captured: ${text.length} chars")
                }
            }
            message.startsWith("__CAGENT_HTML__:") -> {
                val html = message.removePrefix("__CAGENT_HTML__:")
                if (html.length > 10) {
                    htmlRef.set(html)
                    val preview = html.take(150).replace("\n", " ")
                    logger.info("JCEF HTML captured: ${html.length} chars — $preview")
                }
            }
            message.startsWith("__CAGENT_RESPONSE__:") -> {
                val text = message.removePrefix("__CAGENT_RESPONSE__:")
                if (text.length > 3) {
                    responseTextRef.set(text)
                }
            }
            message.startsWith("__CAGENT_DOM__:") -> {
                logger.info("JCEF DOM diagnostic: ${message.removePrefix("__CAGENT_DOM__:")}")
            }
        }
    }

    private fun cleanupConsoleHandler() {
        if (!consoleHandlerInstalled) return
        try {
            val client = cefClient
            val original = originalDisplayHandler
            if (client != null && original != null) {
                val addMethod = client.javaClass.methods.find {
                    it.name == "addDisplayHandler" && it.parameterCount == 1
                }
                addMethod?.invoke(client, original)
            }
        } catch (e: Exception) { logger.trace(e) }
        consoleHandlerInstalled = false
        originalDisplayHandler = null
        cefClient = null
    }
}
