package com.windsurf.controller.services.detection.checks

import java.io.File

fun expandHome(path: String): String {
    if (!path.startsWith("~")) return path
    val home = System.getProperty("user.home") ?: return path
    return File(home, path.removePrefix("~").trimStart(File.separatorChar, '/')).absolutePath
}

fun dirExists(path: String): Boolean {
    val f = File(path)
    return try { f.exists() && f.isDirectory } catch (_: SecurityException) { false }
}

/** Mirror of `dirExists` for single-file configs (Aider's
 *  `~/.aider.conf.yml`). */
fun fileExists(path: String): Boolean {
    val f = File(path)
    return try { f.exists() && f.isFile } catch (_: SecurityException) { false }
}
