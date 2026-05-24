package com.windsurf.controller.services

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.ex.EditorEx
import java.awt.Component
import java.awt.Container
import javax.accessibility.AccessibleContext
import javax.accessibility.AccessibleText
import javax.swing.JEditorPane
import javax.swing.JLabel
import javax.swing.JTextArea
import javax.swing.JTextField
import javax.swing.SwingUtilities
import javax.swing.text.JTextComponent

/**
 * Stateless capture helpers that walk arbitrary Swing component
 * trees to extract rendered text. Used by AgentOutputMonitor's
 * `captureToolWindowContent` to pull bubble text from the Cascade /
 * Copilot / AI Assistant tool windows.
 *
 * No instance state — every method takes the root Component plus
 * accumulators. Logger is a static singleton.
 */
internal object AgentOutputCaptureHelpers {

    private val logger = Logger.getInstance(AgentOutputCaptureHelpers::class.java)

fun collectAccessibleText(component: Component, sb: StringBuilder, depth: Int) {
    if (depth > 15) return
    try {
        val ctx: AccessibleContext? = component.accessibleContext
        if (ctx != null) {
            val at: AccessibleText? = ctx.accessibleText
            if (at != null) {
                val charCount = at.charCount
                if (charCount > 0) {
                    val text = at.getAtIndex(AccessibleText.SENTENCE, 0)
                    if (text != null && text.length > 5) sb.appendLine(text)
                }
            }
            val name = ctx.accessibleName
            if (name != null && name.length > 20) sb.appendLine(name)
            val desc = ctx.accessibleDescription
            if (desc != null && desc.length > 20) sb.appendLine(desc)
        }
    } catch (e: Exception) { logger.trace(e) }
    if (component is Container) {
        for (i in 0 until component.componentCount) {
            collectAccessibleText(component.getComponent(i), sb, depth + 1)
        }
    }
}

/**
 * Append the document text of every live `Editor` (IntelliJ's
 * `EditorEx` / `EditorComponentImpl`) that lives inside the given
 * Swing root. `JTextComponent.getText()` returns nothing for these,
 * so without this pass the AIAssistant chat (and any other tool
 * window that hosts an embedded code editor) looks empty to the
 * snapshot diff.
 */
fun collectEmbeddedEditorText(
    root: Component,
    textParts: MutableList<String>,
    types: MutableSet<String>,
) {
    try {
        val editors = EditorFactory.getInstance().allEditors
        for (editor in editors) {
            val editorComponent = editor.component
            if (!SwingUtilities.isDescendingFrom(editorComponent, root)) continue
            types.add(editorComponent.javaClass.name)
            val text = try { editor.document.text } catch (_: Exception) { "" }
            if (text.isNotBlank()) textParts.add(text)
        }
    } catch (e: Exception) {
        logger.debug("collectEmbeddedEditorText failed: ${e.message}")
    }
}

fun collectSwingText(component: Component, textParts: MutableList<String>, types: MutableSet<String>) {
    types.add(component.javaClass.name)
    when (component) {
        is JEditorPane -> {
            val text = component.text ?: ""
            if (text.isNotBlank()) textParts.add(AgentOutputTextUtils.stripHtml(text))
        }
        is JTextArea -> {
            val text = component.text ?: ""
            if (text.isNotBlank()) textParts.add(text)
        }
        is JTextComponent -> {
            val text = component.text ?: ""
            if (text.length > 10 && component !is JTextField) {
                textParts.add(text)
            }
        }
        is JLabel -> {
            val text = component.text ?: ""
            if (text.length > 20) textParts.add(AgentOutputTextUtils.stripHtml(text))
        }
    }
    if (component is Container) {
        for (i in 0 until component.componentCount) {
            collectSwingText(component.getComponent(i), textParts, types)
        }
    }
}

fun findJBCefBrowser(component: Component): Any? {
    val className = component.javaClass.name

    if (className.contains("\$MyPanel") && className.contains("JBCef")) {
        try {
            val outerField = component.javaClass.getDeclaredField("this\$0")
            outerField.isAccessible = true
            val outer = outerField.get(component)
            if (outer != null) {
                logger.debug("Found JBCefBrowser via \$MyPanel->this\$0: ${outer.javaClass.name}")
                return outer
            }
        } catch (e: Exception) {
            logger.debug("Failed to get outer from \$MyPanel: ${e.message}")
        }
    }

    if (component is Container) {
        for (i in 0 until component.componentCount) {
            val found = findJBCefBrowser(component.getComponent(i))
            if (found != null) return found
        }
    }
    return null
}
}
