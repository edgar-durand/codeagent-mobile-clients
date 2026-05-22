package com.windsurf.controller.services.detection.checks

import java.io.File

/**
 * Returns the absolute path of the first executable in PATH whose
 * basename matches [name], or null. Pure traversal of System.getenv("PATH")
 * — no subprocess. Mirrors the TypeScript whichBinary in the VS Code
 * plugin.
 */
fun whichBinary(name: String): String? {
    val isWin = System.getProperty("os.name")?.lowercase()?.contains("win") == true
    val sep = if (isWin) ";" else ":"
    val exts: List<String> = if (isWin) {
        (System.getenv("PATHEXT") ?: ".EXE;.BAT;.CMD").split(";").map { it.lowercase() }
    } else listOf("")
    val pathEntries = (System.getenv("PATH") ?: "").split(sep).filter { it.isNotBlank() }
    for (dir in pathEntries) {
        for (ext in exts) {
            val candidate = File(dir, name + ext)
            if (candidate.isFile && candidate.canExecute()) {
                return candidate.absolutePath
            }
        }
    }
    return null
}
