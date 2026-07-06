package com.windsurf.controller.protocol

import java.io.File

/**
 * Locates sibling TypeScript sources in the `codeagent-mobile-clients`
 * repo for the cross-language drift tests.
 *
 * Gradle runs the JB plugin tests with the working directory somewhere
 * under `apps/jetbrains-plugin`, but that isn't guaranteed across
 * Gradle versions / IDE test runners — so instead of hardcoding
 * `../../`, walk up from the working dir until the relative path
 * resolves. Returns null when the plugin is built standalone (outside
 * the monorepo); callers `assumeTrue` on that and skip.
 */
internal object ClientsRepoFiles {

    fun resolve(relativePath: String): File? {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            val candidate = File(dir, relativePath)
            if (candidate.isFile) return candidate
            dir = dir.parentFile
        }
        return null
    }
}
