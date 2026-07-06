package com.windsurf.controller.services.detection.checks

import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.extensions.PluginId
import com.windsurf.controller.services.PluginDescriptors

data class PluginRef(val id: String, val minVersion: String? = null)

/**
 * Returns the first installed (and not disabled) plugin from [candidates]
 * whose version satisfies any specified `minVersion`. Null if none.
 */
fun findInstalledPlugin(candidates: List<PluginRef>): PluginRef? {
    for (ref in candidates) {
        val pid = PluginId.getId(ref.id)
        val plugin = PluginDescriptors.findById(pid) ?: continue
        if (PluginManagerCore.isDisabled(pid)) continue
        if (ref.minVersion == null) return ref
        val installed = plugin.version ?: continue
        if (versionAtLeast(installed, ref.minVersion)) return ref
    }
    return null
}

internal fun versionAtLeast(installed: String, minimum: String): Boolean {
    val a = installed.split('.', '-').mapNotNull { it.toIntOrNull() }
    val b = minimum.split('.', '-').mapNotNull { it.toIntOrNull() }
    for (i in 0 until maxOf(a.size, b.size)) {
        val ai = a.getOrNull(i) ?: 0
        val bi = b.getOrNull(i) ?: 0
        if (ai > bi) return true
        if (ai < bi) return false
    }
    return true
}
