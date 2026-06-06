package com.windsurf.controller.services

// Kotlin block comments NEST per project memory feedback_kotlin_
// nested_comments. Single-line '//' comments only inside this file.

import com.google.gson.JsonParser

// Pure decision + parsing helpers extracted from
// UpdateNotifierService so JUnit can exercise the behaviour without
// the IntelliJ Platform fixture. The service shell wires this to
// PropertiesComponent + a real HTTP fetch + the Notifications API,
// but every "should we show the banner?" / "is the cache stale?" /
// "what's the latest version on the wire?" question funnels here.
object UpdateNotifierLogic {

    const val TTL_MS: Long = 24L * 60L * 60L * 1000L

    enum class Decision { SHOW, UP_TO_DATE, SUPPRESSED }

    fun decide(
        currentVersion: String,
        latestVersion: String,
        dismissedVersion: String?,
    ): Decision {
        if (compareSemver(latestVersion, currentVersion) <= 0) return Decision.UP_TO_DATE
        if (dismissedVersion == latestVersion) return Decision.SUPPRESSED
        return Decision.SHOW
    }

    fun isCacheFresh(fetchedAt: Long, now: Long): Boolean = now - fetchedAt < TTL_MS

    // Parse the marketplace `/api/plugins/{xmlId}/updates` payload.
    // Returns the first entry's `version` field, or null when the
    // payload is empty / malformed - never throws. Marketplace sorts
    // by cdate descending so [0] is the most recent publish.
    fun parseLatestVersion(json: String): String? {
        if (json.isBlank()) return null
        return try {
            val arr = JsonParser.parseString(json).asJsonArray
            if (arr.size() == 0) return null
            val first = arr.get(0).asJsonObject
            if (!first.has("version")) return null
            val v = first.get("version")
            if (v.isJsonNull) return null
            v.asString
        } catch (_: Throwable) {
            null
        }
    }

    // Numeric semver compare, pre-release suffix stripped. Returns 1
    // if a > b, -1 if a < b, 0 if equal. Stripping `-rc.N` etc.
    // matches the CLI + VS Code plugin's policy: a stable user is
    // never told to install a pre-release.
    fun compareSemver(a: String, b: String): Int {
        val aParts = stripPre(a).split('.').map { it.toIntOrNull() ?: 0 }
        val bParts = stripPre(b).split('.').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until 3) {
            val ai = aParts.getOrNull(i) ?: 0
            val bi = bParts.getOrNull(i) ?: 0
            if (ai > bi) return 1
            if (ai < bi) return -1
        }
        return 0
    }

    private fun stripPre(s: String): String = s.substringBefore('-')
}
