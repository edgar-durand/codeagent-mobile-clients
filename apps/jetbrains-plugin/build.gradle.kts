plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.0.21"
    id("org.jetbrains.intellij.platform") version "2.2.1"
    id("org.jetbrains.changelog") version "2.2.1"
}

group = "com.codeagent.mobile"
version = "2.0.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.google.code.gson:gson:2.10.1")
    implementation("org.java-websocket:Java-WebSocket:1.5.6")
    implementation("com.google.zxing:core:3.5.3")
    implementation("com.google.zxing:javase:3.5.3")
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
            untilBuild = "261.*"
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
        token = System.getenv("PUBLISH_TOKEN") ?: ""
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
