package com.windsurf.controller.services.detection.checks

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindowManager
import java.util.concurrent.atomic.AtomicReference

/**
 * Probes the project's `ToolWindowManager` for the first id in
 * [candidates] that resolves to a registered tool window. Hops to the
 * EDT internally — callers can invoke from any thread.
 *
 * Returns the resolved tool-window id (preserving the candidate's
 * casing as provided in [candidates]) or null when none is present.
 */
fun findOpenToolWindowId(project: Project, candidates: List<String>): String? {
    val ref = AtomicReference<String?>(null)
    val task = Runnable {
        try {
            val twm = ToolWindowManager.getInstance(project)
            for (id in candidates) {
                if (twm.getToolWindow(id) != null) {
                    ref.set(id)
                    return@Runnable
                }
            }
        } catch (_: Exception) {
            // Project disposed mid-probe — null result is fine.
        }
    }
    val app = ApplicationManager.getApplication()
    if (app.isDispatchThread) task.run() else app.invokeAndWait(task)
    return ref.get()
}

/**
 * Enumerates every registered tool window id in [project]. Used by
 * the dynamic-plugin discovery detector to surface tool windows that
 * no specific detector claimed (catch-all). EDT-safe.
 */
fun listToolWindowIds(project: Project): List<String> {
    val ref = AtomicReference<List<String>>(emptyList())
    val task = Runnable {
        try {
            ref.set(ToolWindowManager.getInstance(project).toolWindowIds.toList())
        } catch (_: Exception) {
            // Project disposed mid-probe.
        }
    }
    val app = ApplicationManager.getApplication()
    if (app.isDispatchThread) task.run() else app.invokeAndWait(task)
    return ref.get()
}
