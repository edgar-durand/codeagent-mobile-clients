plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.3.21"
    id("org.jetbrains.intellij.platform") version "2.16.0"
    id("org.jetbrains.changelog") version "2.5.0"
}

group = "com.codeagent.mobile"
version = "2.10.8"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:5.3.2")
    implementation("com.google.code.gson:gson:2.14.0")
    implementation("org.java-websocket:Java-WebSocket:1.6.0")
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
