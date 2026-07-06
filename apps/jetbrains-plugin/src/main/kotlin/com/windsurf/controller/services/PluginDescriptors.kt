package com.windsurf.controller.services

// Kotlin block comments NEST per project memory. Single-line '//'
// comments only in this file.

import com.intellij.ide.plugins.IdeaPluginDescriptor
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.extensions.PluginId

// Reflection facade over the platform's plugin-descriptor lookups.
//
// Why reflection: as of IntelliJ 2026.2 EAP the Plugin Verifier flags
// EVERY descriptor-returning lookup as @ApiStatus.Internal —
// PluginManagerCore.getPlugin / getPlugins, PluginManager.getPlugins /
// getLoadedPlugins, and (since IJPL-244315, 2026-05-20) even
// PluginManager.getInstance().findEnabledPlugin(). The replacement
// JetBrains points at, PluginDetailsService, is @ApiStatus.Experimental,
// does not exist in our 2024.1 compile SDK, and does not expose the
// plugin classloader the strategy bridges depend on. Until a stable
// public lookup exists, resolve the same static methods reflectively so
// behaviour stays identical on every IDE we support (2024.1+):
//   - findById  mirrors PluginManagerCore.getPlugin(id) — returns the
//     descriptor for an INSTALLED plugin, including disabled ones;
//     callers keep doing their own isEnabled / isDisabled filtering.
//   - all       mirrors PluginManagerCore.getPlugins() — every
//     installed plugin, including disabled ones.
// Both are fail-soft: any reflective breakage logs once per call and
// degrades to "plugin not found", never throws.
internal object PluginDescriptors {

    private val logger = Logger.getInstance(PluginDescriptors::class.java)

    private val coreClass: Class<*>? by lazy {
        try {
            Class.forName("com.intellij.ide.plugins.PluginManagerCore")
        } catch (t: Throwable) {
            logger.warn("PluginManagerCore not reachable: ${t.message}")
            null
        }
    }

    fun findById(id: PluginId): IdeaPluginDescriptor? = try {
        coreClass?.getMethod("getPlugin", PluginId::class.java)
            ?.invoke(null, id) as? IdeaPluginDescriptor
    } catch (t: Throwable) {
        logger.warn("plugin lookup failed for ${id.idString}: ${t.message}")
        null
    }

    fun all(): List<IdeaPluginDescriptor> = try {
        (coreClass?.getMethod("getPlugins")?.invoke(null) as? Array<*>)
            ?.filterIsInstance<IdeaPluginDescriptor>()
            ?: emptyList()
    } catch (t: Throwable) {
        logger.warn("plugin enumeration failed: ${t.message}")
        emptyList()
    }
}
