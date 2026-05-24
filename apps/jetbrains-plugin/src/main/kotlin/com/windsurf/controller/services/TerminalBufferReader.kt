package com.windsurf.controller.services

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.editor.Editor
import java.awt.Component
import java.awt.Container
import javax.accessibility.AccessibleText
import javax.swing.JEditorPane
import javax.swing.JLabel
import javax.swing.JTextArea
import javax.swing.JTextField
import javax.swing.text.JTextComponent

/**
 * Reflection-backed reader for the IDE's terminal widget. Owns the
 * 15+ helpers TerminalAgentService used to inline — they walk the
 * IntelliJ Editor / JediTerm component trees + reflect into the
 * private TerminalTextBuffer to extract the current screen content.
 *
 * No instance state — every method takes the component (or buffer
 * object) it operates on. Logger is a static singleton so call
 * sites don't have to thread one through.
 *
 * Why so many strategies: JediTerm's text buffer is `private` and
 * its field name has changed between IntelliJ Platform releases
 * (2023.1+ "textBuffer", earlier "myTextBuffer"). Each strategy is a
 * fallback for the previous one — readTerminalText tries them in
 * priority order and returns the first non-null result.
 */
internal object TerminalBufferReader {

    private val logger = Logger.getInstance(TerminalBufferReader::class.java)

fun findTerminalWidget(component: Component): Any? {
    val targetNames = listOf(
        "org.jetbrains.plugins.terminal.ShellTerminalWidget",
        "org.jetbrains.plugins.terminal.JBTerminalWidget",
        "com.jediterm.terminal.ui.JediTermWidget"
    )
    fun isTarget(comp: Component): Boolean {
        var clazz: Class<*>? = comp.javaClass
        while (clazz != null) {
            if (clazz.name in targetNames) return true
            clazz = clazz.superclass
        }
        return false
    }
    fun search(comp: Component): Component? {
        if (isTarget(comp)) return comp
        if (comp is java.awt.Container) {
            for (child in comp.components) {
                val found = search(child)
                if (found != null) return found
            }
        }
        return null
    }
    return search(component)
}

fun logWidgetDetails(widget: Any) {
    val cls = widget.javaClass
    val methods = cls.methods.map { it.name }.distinct().sorted()
    logger.info("Terminal widget class: ${cls.name}")
    logger.info("Terminal widget methods: ${methods.joinToString(", ")}")

    var parent: Class<*>? = cls.superclass
    val hierarchy = mutableListOf(cls.name)
    while (parent != null && parent != Any::class.java) {
        hierarchy.add(parent.name)
        parent = parent.superclass
    }
    logger.info("Terminal widget hierarchy: ${hierarchy.joinToString(" → ")}")
}

fun tryReadFromEditors(component: Component): String? {
    try {
        val editorClass = Class.forName("com.intellij.openapi.editor.impl.EditorComponentImpl")
        val editors = mutableListOf<Any>()
        collectComponentsByClass(component, editorClass, editors)
        if (editors.isNotEmpty()) {
            val sb = StringBuilder()
            for (editor in editors) {
                try {
                    val getEditor = editor.javaClass.getMethod("getEditor")
                    val editorObj = getEditor.invoke(editor)
                    val getDocument = editorObj.javaClass.getMethod("getDocument")
                    val doc = getDocument.invoke(editorObj)
                    val getText = doc.javaClass.getMethod("getText")
                    val text = getText.invoke(doc)?.toString()
                    if (!text.isNullOrBlank()) sb.appendLine(text)
                } catch (_: Exception) {}
            }
            val result = sb.toString().trim()
            if (result.length > 5) return result
        }
    } catch (_: Exception) {}
    return null
}

fun collectComponentsByClass(component: Component, targetClass: Class<*>, result: MutableList<Any>) {
    if (targetClass.isInstance(component)) {
        result.add(component)
    }
    if (component is java.awt.Container) {
        for (child in component.components) {
            collectComponentsByClass(child, targetClass, result)
        }
    }
}

fun readFromTerminalWidget(widget: Any): String? {
    // Try getTerminalTextBuffer() → TerminalTextBuffer (public API)
    for (bufferMethod in listOf("getTerminalTextBuffer", "getTextBuffer")) {
        try {
            val buffer = widget.javaClass.getMethod(bufferMethod).invoke(widget) ?: continue
            logger.info("readFromTerminalWidget: found buffer via $bufferMethod → ${buffer.javaClass.name}")
            val bufferText = readTerminalTextBuffer(buffer)
            if (!bufferText.isNullOrBlank()) return bufferText
        } catch (e: Exception) {
            logger.debug("readFromTerminalWidget: $bufferMethod failed: ${e.message}")
        }
    }

    // Try getTerminal() → Terminal → getTextBuffer()
    try {
        val terminal = widget.javaClass.getMethod("getTerminal").invoke(widget)
        if (terminal != null) {
            logger.info("readFromTerminalWidget: found terminal → ${terminal.javaClass.name}")
            for (bufferMethod in listOf("getTextBuffer", "getTerminalTextBuffer")) {
                try {
                    val buffer = terminal.javaClass.getMethod(bufferMethod).invoke(terminal) ?: continue
                    val bufferText = readTerminalTextBuffer(buffer)
                    if (!bufferText.isNullOrBlank()) return bufferText
                } catch (_: Exception) {}
            }
        }
    } catch (_: Exception) {}

    // Try getTerminalPanel() → TerminalPanel → getTerminalTextBuffer()
    try {
        val panel = widget.javaClass.getMethod("getTerminalPanel").invoke(widget)
        if (panel != null) {
            logger.info("readFromTerminalWidget: found panel → ${panel.javaClass.name}")
            for (bufferMethod in listOf("getTerminalTextBuffer", "getTextBuffer")) {
                try {
                    val buffer = panel.javaClass.getMethod(bufferMethod).invoke(panel) ?: continue
                    val bufferText = readTerminalTextBuffer(buffer)
                    if (!bufferText.isNullOrBlank()) return bufferText
                } catch (_: Exception) {}
            }
            val bufferText = extractTextFromTerminalObject(panel)
            if (!bufferText.isNullOrBlank()) return bufferText
        }
    } catch (_: Exception) {}

    // Walk declared fields with setAccessible to find buffer objects
    val visited = mutableSetOf<Int>()
    return walkFieldsForBuffer(widget, 0, visited)
}

fun walkFieldsForBuffer(obj: Any, depth: Int, visited: MutableSet<Int>): String? {
    if (depth > 4) return null
    val id = System.identityHashCode(obj)
    if (id in visited) return null
    visited.add(id)

    var cls: Class<*>? = obj.javaClass
    while (cls != null && cls != Any::class.java) {
        for (field in cls.declaredFields) {
            try {
                field.isAccessible = true
                val value = field.get(obj) ?: continue
                val valClass = value.javaClass.name

                // Check if this is a text buffer
                if (valClass.contains("TextBuffer", ignoreCase = true) ||
                    valClass.contains("TerminalModel", ignoreCase = true) ||
                    valClass.contains("OutputModel", ignoreCase = true)) {
                    logger.info("walkFieldsForBuffer: found ${field.name}: $valClass")
                    val text = readTerminalTextBuffer(value)
                    if (!text.isNullOrBlank()) return text
                    val text2 = extractTextFromTerminalObject(value)
                    if (!text2.isNullOrBlank()) return text2
                }

                // Recurse into terminal-related objects
                if (valClass.contains("Terminal", ignoreCase = true) ||
                    valClass.contains("Session", ignoreCase = true) ||
                    valClass.contains("JediTerm", ignoreCase = true)) {
                    val result = walkFieldsForBuffer(value, depth + 1, visited)
                    if (result != null) return result
                }
            } catch (_: Exception) {}
        }
        cls = cls.superclass
    }
    return null
}

fun tryAggressiveFieldWalk(component: Component, depth: Int): String? {
    if (depth > 3) return null
    val visited = mutableSetOf<Int>()
    val result = walkFieldsForBuffer(component, 0, visited)
    if (result != null) return result

    if (component is java.awt.Container) {
        for (child in component.components) {
            val childResult = tryAggressiveFieldWalk(child, depth + 1)
            if (childResult != null) return childResult
        }
    }
    return null
}

fun readTerminalTextBuffer(buffer: Any): String? {
    // Try getScreenLines() — returns all visible screen content
    try {
        val screenLines = buffer.javaClass.getMethod("getScreenLines").invoke(buffer)?.toString()
        if (!screenLines.isNullOrBlank() && screenLines.length > 3) {
            logger.info("readTerminalTextBuffer: getScreenLines returned ${screenLines.length} chars")
            return screenLines
        }
    } catch (_: Exception) {}

    // Try lock + getScreenLines for thread-safe access
    try {
        val lockMethod = buffer.javaClass.getMethod("lock")
        val unlockMethod = buffer.javaClass.getMethod("unlock")
        lockMethod.invoke(buffer)
        try {
            val screenLines = buffer.javaClass.getMethod("getScreenLines").invoke(buffer)?.toString()
            if (!screenLines.isNullOrBlank() && screenLines.length > 3) {
                unlockMethod.invoke(buffer)
                return screenLines
            }
        } finally {
            try { unlockMethod.invoke(buffer) } catch (_: Exception) {}
        }
    } catch (_: Exception) {}

    // Try reading line by line: getHeight() + getLine(int)
    try {
        val height = buffer.javaClass.getMethod("getHeight").invoke(buffer) as Int
        val sb = StringBuilder()
        for (i in 0 until height) {
            try {
                val line = buffer.javaClass.getMethod("getLine", Int::class.javaPrimitiveType)
                    .invoke(buffer, i)
                if (line != null) sb.appendLine(line.toString())
            } catch (_: Exception) {}
        }
        if (sb.isNotBlank()) return sb.toString().trim()
    } catch (_: Exception) {}

    // Try historyBuffer + screenBuffer
    try {
        val historyText = StringBuilder()
        for (name in listOf("getHistoryBuffer", "getHistoryLines")) {
            try {
                val history = buffer.javaClass.getMethod(name).invoke(buffer)
                if (history != null) historyText.append(history.toString())
            } catch (_: Exception) {}
        }
        val screenText = try {
            buffer.javaClass.getMethod("getScreenLines").invoke(buffer)?.toString() ?: ""
        } catch (_: Exception) { "" }
        val combined = (historyText.toString() + "\n" + screenText).trim()
        if (combined.length > 3) return combined
    } catch (_: Exception) {}

    return null
}

fun dumpComponentTree(component: Component, sb: StringBuilder, depth: Int) {
    if (depth > 6) return
    val indent = "  ".repeat(depth)
    sb.appendLine("$indent${component.javaClass.name} [${component.width}x${component.height}]")
    if (component is java.awt.Container) {
        for (child in component.components) {
            dumpComponentTree(child, sb, depth + 1)
        }
    }
}

fun tryTerminalModelRead(component: Component): String? {
    try {
        val cls = component.javaClass

        // BlockTerminalPanel / TerminalPanel — try to get the session or controller
        for (fieldName in listOf("mySession", "myTerminal", "myController", "myTermWidget",
            "terminalWidget", "myContent", "myBlockTerminalView")) {
            try {
                val field = findFieldRecursive(cls, fieldName) ?: continue
                field.isAccessible = true
                val obj = field.get(component) ?: continue

                // Try getTerminalTextBuffer or similar on the session/terminal object
                val bufferText = extractTextFromTerminalObject(obj)
                if (bufferText != null && bufferText.length > 10) return bufferText
            } catch (_: Exception) {}
        }

        // Try methods on the component itself
        for (methodName in listOf("getTerminalTextBuffer", "getText", "getOutputModel",
            "getController", "getSession", "getTerminalModel")) {
            try {
                val method = cls.getMethod(methodName)
                val result = method.invoke(component) ?: continue
                val bufferText = extractTextFromTerminalObject(result)
                if (bufferText != null && bufferText.length > 10) return bufferText
            } catch (_: Exception) {}
        }
    } catch (_: Exception) {}

    // Recurse into child components
    if (component is java.awt.Container) {
        for (child in component.components) {
            val result = tryTerminalModelRead(child)
            if (result != null) return result
        }
    }
    return null
}

fun findFieldRecursive(cls: Class<*>, name: String): java.lang.reflect.Field? {
    var current: Class<*>? = cls
    while (current != null && current != Any::class.java) {
        try {
            return current.getDeclaredField(name)
        } catch (_: NoSuchFieldException) {}
        current = current.superclass
    }
    return null
}

fun extractTextFromTerminalObject(obj: Any): String? {
    // Try common methods to extract text from terminal session/buffer objects
    for (methodName in listOf("getTerminalTextBuffer", "getTextBuffer", "getText",
        "getScreenLines", "getHistoryBuffer", "getAllText")) {
        try {
            val method = obj.javaClass.getMethod(methodName)
            val result = method.invoke(obj) ?: continue
            val text = result.toString()
            if (text.length > 10 && !text.startsWith("com.") && !text.startsWith("org.")) {
                return text
            }
            // For buffer objects, try getLines/getText on the result
            for (subMethod in listOf("getLines", "getText", "toString", "getScreenLines")) {
                try {
                    val sub = result.javaClass.getMethod(subMethod)
                    val subResult = sub.invoke(result)?.toString()
                    if (!subResult.isNullOrBlank() && subResult.length > 10) return subResult
                } catch (_: Exception) {}
            }
        } catch (_: Exception) {}
    }

    // Try to read all lines from the buffer if it has size/getLine methods
    try {
        val lineCountMethod = obj.javaClass.getMethod("getLineCount")
        val lineCount = lineCountMethod.invoke(obj) as Int
        if (lineCount > 0) {
            val getLineMethod = obj.javaClass.getMethod("getLine", Int::class.javaPrimitiveType)
            val sb = StringBuilder()
            for (i in 0 until minOf(lineCount, 500)) {
                val line = getLineMethod.invoke(obj, i)?.toString()
                if (line != null) sb.appendLine(line)
            }
            if (sb.isNotBlank()) return sb.toString().trim()
        }
    } catch (_: Exception) {}

    return null
}

fun collectTextComponents(component: Component, result: MutableList<JTextComponent>) {
    if (component is JTextComponent) {
        result.add(component)
    }
    if (component is java.awt.Container) {
        for (child in component.components) {
            collectTextComponents(child, result)
        }
    }
}

fun collectAccessibleText(component: Component, sb: StringBuilder, depth: Int) {
    if (depth > 15) return
    try {
        val ctx = component.accessibleContext
        if (ctx != null) {
            val at = ctx.accessibleText
            if (at != null) {
                val charCount = at.getCharCount()
                if (charCount > 0) {
                    val txt = at.getAtIndex(AccessibleText.SENTENCE, 0)
                    if (txt != null) {
                        sb.appendLine(txt)
                    } else {
                        // Read character by character for short segments
                        val readLen = minOf(charCount, 5000)
                        val chars = StringBuilder()
                        for (i in 0 until readLen) {
                            val c = at.getAtIndex(AccessibleText.CHARACTER, i)
                            if (c != null) chars.append(c)
                        }
                        if (chars.isNotBlank()) sb.appendLine(chars.toString())
                    }
                }
            }
            // Also try accessible name/description
            val name = ctx.accessibleName
            val desc = ctx.accessibleDescription
            if (!name.isNullOrBlank() && name.length > 10) sb.appendLine(name)
            if (!desc.isNullOrBlank() && desc.length > 10) sb.appendLine(desc)
        }
    } catch (_: Exception) {}
    if (component is java.awt.Container) {
        for (child in component.components) {
            collectAccessibleText(child, sb, depth + 1)
        }
    }
}

fun tryReflectionRead(component: Component): String? {
    // Walk component tree looking for objects with terminal buffer methods
    try {
        val cls = component.javaClass
        // Try getModel() — some terminal views expose output model
        for (methodName in listOf("getModel", "getSession", "getTerminalTextBuffer",
            "getTerminal", "getTextBuffer", "getOutput", "getDocument")) {
            try {
                val method = cls.getMethod(methodName)
                val result = method.invoke(component)
                if (result != null) {
                    val text = result.toString()
                    if (text.length > 20 && !text.startsWith("org.") && !text.startsWith("com.")) {
                        return text
                    }
                    // Try toString on children methods
                    for (subMethod in listOf("getText", "toString", "getTextBuffer")) {
                        try {
                            val sub = result.javaClass.getMethod(subMethod)
                            val subResult = sub.invoke(result)?.toString()
                            if (!subResult.isNullOrBlank() && subResult.length > 20) return subResult
                        } catch (_: Exception) {}
                    }
                }
            } catch (_: Exception) {}
        }
    } catch (_: Exception) {}

    if (component is java.awt.Container) {
        for (child in component.components) {
            val result = tryReflectionRead(child)
            if (result != null) return result
        }
    }
    return null
}
}
