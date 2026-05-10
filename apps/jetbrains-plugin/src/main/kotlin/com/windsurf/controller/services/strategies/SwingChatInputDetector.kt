package com.windsurf.controller.services.strategies

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.wm.ToolWindow
import java.awt.Component
import java.awt.Container
import javax.swing.AbstractButton
import javax.swing.text.JTextComponent

/**
 * Generic chat input + send-button detector for Swing-rendered chat
 * panels (the legacy fallback path for `CopilotChatStrategy` and the
 * primary path for `JetBrainsAIAssistantStrategy`).
 *
 * Picks the bottom-most editable `JTextComponent` as the chat input,
 * then scores every visible `AbstractButton` in the footer band by:
 *
 *   - exact `templatePresentation.text == "Send" / "Submit"` → +300000
 *   - `templatePresentation.text` or `actionClassName` contains
 *     "send" / "submit" → +150000–200000
 *   - tooltip / accessibleName contains "send" / "submit" → +100000
 *   - on-screen X (rightmost wins ties) → +x
 *   - tooltip / action mentions "attach" / "delegate" / "dropdown" /
 *     "model" / "combo" / "popup" / "stop" → −50000 each
 *
 * Returns the highest-scoring candidate above 0; if nothing scores the
 * caller should dispatch Enter on the input directly.
 *
 * **Why presentation text, not tooltip:** `ActionButton.toolTipText` is
 * built lazily on mouse hover and returns `null` for prompts dispatched
 * from a paired mobile device (no mouse interaction). The action's
 * `templatePresentation.text` is set at plugin registration time and
 * is always populated.
 */
internal data class SwingChatTarget(
    val input: JTextComponent,
    val sendButton: AbstractButton?,
)

internal fun detectSwingChatTarget(tw: ToolWindow): SwingChatTarget? {
    val inputs = mutableListOf<JTextComponent>()
    val buttons = mutableListOf<AbstractButton>()

    fun walk(c: Component) {
        // Don't gate recursion on visibility — the root tool-window
        // component reports `isVisible == false` until layout completes,
        // but its descendants are already attached.
        if (c is JTextComponent && c.isEditable && c.isEnabled && c.isVisible) inputs.add(c)
        if (c is AbstractButton && c.isEnabled && c.isVisible) buttons.add(c)
        if (c is Container) {
            for (i in 0 until c.componentCount) walk(c.getComponent(i))
        }
    }

    val edtTask = Runnable {
        // Some tool windows (current Copilot Chat, AI Assistant) mount
        // their UI directly on `tw.component` instead of registering
        // it through `contentManager.contents`. Walk both.
        val contents = tw.contentManager.contents
        if (contents.isNotEmpty()) {
            for (content in contents) walk(content.component)
        } else {
            walk(tw.component)
        }
    }
    val app = ApplicationManager.getApplication()
    if (app.isDispatchThread) edtTask.run() else try {
        app.invokeAndWait(edtTask)
    } catch (_: Exception) {}

    if (inputs.isEmpty()) return null

    val input = inputs.maxByOrNull {
        try { it.locationOnScreen.y } catch (_: Exception) { it.y }
    } ?: return null

    val inputLoc = try { input.locationOnScreen } catch (_: Exception) {
        return SwingChatTarget(input, null)
    }
    val inputBottom = inputLoc.y + input.height

    val sendButton = buttons
        .asSequence()
        .filter {
            try {
                val bl = it.locationOnScreen
                bl.y in (inputLoc.y - 40)..(inputBottom + 120) && it.isShowing
            } catch (_: Exception) { false }
        }
        .map { it to scoreSendCandidate(it, inputLoc.x) }
        .filter { it.second > 0 }
        .maxByOrNull { it.second }
        ?.first

    return SwingChatTarget(input, sendButton)
}

/**
 * Reflectively read the `AnAction` wrapped by an `ActionButton` and
 * its `templatePresentation.text`. Returns `("", "")` if the button
 * isn't an action button or the reflection chain breaks.
 */
private fun readActionInfo(btn: AbstractButton): Pair<String, String> {
    return try {
        val getAction = btn.javaClass.getMethod("getAction")
        val action = getAction.invoke(btn) ?: return "" to ""
        val actionCls = action.javaClass.name
        val presText = try {
            val getPres = action.javaClass.getMethod("getTemplatePresentation")
            val pres = getPres.invoke(action) ?: return actionCls to ""
            val getText = pres.javaClass.getMethod("getText")
            (getText.invoke(pres) as? String) ?: ""
        } catch (_: Exception) { "" }
        actionCls to presText
    } catch (_: Exception) {
        "" to ""
    }
}

private fun scoreSendCandidate(btn: AbstractButton, inputX: Int): Long {
    var score = 0L

    val btnX = try { btn.locationOnScreen.x } catch (_: Exception) { 0 }
    score += btnX.toLong()
    if (btnX < inputX) score -= 5000

    val tooltip = (btn.toolTipText ?: "").lowercase()
    val accName = try {
        (btn.accessibleContext?.accessibleName ?: "").lowercase()
    } catch (_: Exception) { "" }
    val (actionCls, presText) = readActionInfo(btn)
    val presLower = presText.lowercase()
    val actionClsLower = actionCls.lowercase()

    if (tooltip.contains("send") || tooltip.contains("submit")) score += 100_000
    if (accName.contains("send") || accName.contains("submit")) score += 100_000
    if (presLower == "send" || presLower == "submit") score += 300_000
    else if (presLower.contains("send") || presLower.contains("submit")) score += 150_000
    if (actionClsLower.contains("send") || actionClsLower.contains("submit")) score += 200_000

    val negatives = listOf("attach", "delegate", "dropdown", "model", "combo", "popup", "agent picker", "stop")
    for (neg in negatives) {
        if (tooltip.contains(neg)) score -= 50_000
        if (accName.contains(neg)) score -= 50_000
        if (presLower.contains(neg)) score -= 50_000
        if (actionClsLower.contains(neg)) score -= 50_000
    }

    return score
}
