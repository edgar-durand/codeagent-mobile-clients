plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.4.0"
    id("org.jetbrains.intellij.platform") version "2.16.0"
    id("org.jetbrains.changelog") version "2.5.0"
}

group = "com.codeagent.mobile"
version = "2.39.14"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:5.4.0")
    implementation("com.google.code.gson:gson:2.14.0")
    implementation("com.google.zxing:core:3.5.4")
    implementation("com.google.zxing:javase:3.5.4")
    testImplementation("org.jetbrains.kotlin:kotlin-test")
    testImplementation("junit:junit:4.13.2")

    intellijPlatform {
        intellijIdeaUltimate("2024.1")
        bundledPlugin("org.jetbrains.plugins.terminal")
        pluginVerifier()
    }
}

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "241"
            // untilBuild deliberately omitted (open-ended). This is a
            // tool-window + actions plugin that doesn't touch internal
            // APIs, so capping it would just flag the plugin as
            // incompatible the moment a new EAP build ships. Re-enable
            // only if a hard API break forces a divergent release.
        }

        changeNotes = provider {
            with(changelog) {
                renderItem(
                    (getOrNull(project.version.toString()) ?: getLatest())
                        .withHeader(false)
                        .withEmptySections(false),
                    org.jetbrains.changelog.Changelog.OutputType.HTML,
                )
            }
        }
    }

    signing {
        certificateChain = System.getenv("CERTIFICATE_CHAIN") ?: ""
        privateKey = System.getenv("PRIVATE_KEY") ?: ""
        password = System.getenv("PRIVATE_KEY_PASSWORD") ?: ""
    }

    publishing {
        token = providers.environmentVariable("PUBLISH_TOKEN").orElse("")
        channels = listOf("default")
    }

    pluginVerification {
        // The plugin claims compatibility with com.intellij.modules.platform
        // (= all IntelliJ-family IDEs) and is published to the marketplace
        // listing for 11 flavours. Verify against the products with the
        // smallest bundled-API surface (IC / PC / GO) so the verifier
        // catches missing-dependency errors before publish. Each ide()
        // call resolves to a cached IDE distribution on first run.
        ides {
            // Verifier downloads the IDE distribution per type. Cover the
            // products with the smallest bundled-API surface so a missing
            // dependency is caught before a marketplace listing claims
            // false compatibility.
            create(org.jetbrains.intellij.platform.gradle.IntelliJPlatformType.IntellijIdeaUltimate, "2024.1")
            create(org.jetbrains.intellij.platform.gradle.IntelliJPlatformType.IntellijIdeaCommunity, "2024.1")
            create(org.jetbrains.intellij.platform.gradle.IntelliJPlatformType.WebStorm, "2024.1")
            create(org.jetbrains.intellij.platform.gradle.IntelliJPlatformType.PyCharmProfessional, "2024.1")
            create(org.jetbrains.intellij.platform.gradle.IntelliJPlatformType.PyCharmCommunity, "2024.1")
            create(org.jetbrains.intellij.platform.gradle.IntelliJPlatformType.GoLand, "2024.1")
        }

        // The default failure-level set in IntelliJ Platform Gradle plugin
        // 2.15.0+ flags INTERNAL_API_USAGES + OVERRIDE_ONLY_API_USAGES at
        // failure level, which trips us on auto-generated Kotlin bridge
        // methods over ToolWindowFactory defaults.
        //
        // PLUGIN_STRUCTURE_WARNINGS is back in the list — the only
        // historical trigger ("untilBuild points at an unreleased EAP")
        // is gone now that the cap is open-ended. Anything else it
        // catches (missing icon, vendor info, description length…) is
        // genuine metadata drift we want to know about before push.
        failureLevel = listOf(
            org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask.FailureLevel.INVALID_PLUGIN,
            org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask.FailureLevel.MISSING_DEPENDENCIES,
            org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask.FailureLevel.PLUGIN_STRUCTURE_WARNINGS,
        )
    }
}

changelog {
    version = project.version.toString()
    path = file("CHANGELOG.md").canonicalPath
    headerParserRegex = """(\d+\.\d+\.\d+)""".toRegex()
    groups = emptyList()
}

kotlin {
    jvmToolchain(17)
}

// ─── Build-time PostHog config injection ─────────────────────────
// Mirrors the CLI's tsup `define` (apps/cli/tsup.config.ts) — the API
// key is read from POSTHOG_API_KEY in CI and baked into a generated
// Kotlin object that TelemetryService consumes. Local builds with no
// env var produce an empty key, which TelemetryService treats as
// "no-op". The generated file is NOT checked in.
val generatedSourcesDir = layout.buildDirectory.dir("generated/sources/buildconfig/kotlin/main")

val generateBuildConfig by tasks.registering {
    val key = providers.environmentVariable("POSTHOG_API_KEY").orElse("")
    val host = providers.environmentVariable("POSTHOG_HOST").orElse("https://us.i.posthog.com")
    val ver = project.version.toString()
    inputs.property("posthogKey", key)
    inputs.property("posthogHost", host)
    inputs.property("version", ver)
    outputs.dir(generatedSourcesDir)
    doLast {
        val outFile = generatedSourcesDir.get().file("com/windsurf/controller/GeneratedBuildConfig.kt").asFile
        outFile.parentFile.mkdirs()
        outFile.writeText(
            """
            // GENERATED FILE — DO NOT EDIT. Source: build.gradle.kts (generateBuildConfig task).
            // Repopulated on every build from POSTHOG_API_KEY / POSTHOG_HOST env vars.
            package com.windsurf.controller

            object GeneratedBuildConfig {
                const val POSTHOG_API_KEY: String = ${"\"" + key.get().replace("\"", "\\\"") + "\""}
                const val POSTHOG_HOST: String = ${"\"" + host.get().replace("\"", "\\\"") + "\""}
                const val PLUGIN_VERSION: String = ${"\"" + ver.replace("\"", "\\\"") + "\""}
            }
            """.trimIndent() + "\n"
        )
    }
}

sourceSets {
    named("main") {
        kotlin.srcDir(generatedSourcesDir)
    }
}

tasks.named("compileKotlin") {
    dependsOn(generateBuildConfig)
}
