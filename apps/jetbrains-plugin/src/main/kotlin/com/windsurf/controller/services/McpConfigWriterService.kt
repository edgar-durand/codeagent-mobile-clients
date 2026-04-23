package com.windsurf.controller.services

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.ProjectManager
import java.io.File
import java.nio.file.Paths

data class McpEntry(
    val id: String,
    val server: McpServerDef,
    val env: Map<String, String>
)

data class McpServerDef(
    val command: String,
    val args: List<String>
)

data class McpConfigureRequest(
    val scope: String,
    val mcps: List<McpEntry>,
    val targetAgents: List<String>?
)

data class McpWriteResult(
    val agent: String,
    val file: String,
    val status: String,
    val error: String? = null
)

@Service(Service.Level.APP)
class McpConfigWriterService {

    private val logger = Logger.getInstance(McpConfigWriterService::class.java)
    private val gson: Gson = GsonBuilder().setPrettyPrinting().create()

    private val homeDir: String = System.getProperty("user.home")

    interface ConfigAdapter {
        val agentName: String
        val agentPluginIds: Set<String>
        fun globalConfigPath(): String
        fun projectConfigPath(projectRoot: String): String
        fun buildConfigJson(mcps: List<McpEntry>): String
    }

    // ── Cursor ─────────────────────────────────────────────
    private inner class CursorAdapter : ConfigAdapter {
        override val agentName = "Cursor"
        override val agentPluginIds = setOf("com.cursor.ide")

        override fun globalConfigPath(): String =
            Paths.get(homeDir, ".cursor", "mcp.json").toString()

        override fun projectConfigPath(projectRoot: String): String =
            Paths.get(projectRoot, ".cursor", "mcp.json").toString()

        override fun buildConfigJson(mcps: List<McpEntry>): String {
            val servers = JsonObject()
            for (mcp in mcps) {
                val entry = JsonObject()
                entry.addProperty("command", mcp.server.command)
                val argsArray = JsonArray()
                mcp.server.args.forEach { argsArray.add(resolveArg(it, mcp.env)) }
                entry.add("args", argsArray)
                val envObj = JsonObject()
                mcp.env.forEach { (k, v) -> envObj.addProperty(k, v) }
                if (envObj.size() > 0) entry.add("env", envObj)
                servers.add(mcp.id, entry)
            }
            val root = JsonObject()
            root.add("mcpServers", servers)
            return gson.toJson(root)
        }
    }

    // ── Windsurf / Codeium ─────────────────────────────────
    private inner class WindsurfAdapter : ConfigAdapter {
        override val agentName = "Windsurf"
        override val agentPluginIds = setOf("com.codeium.intellij")

        override fun globalConfigPath(): String =
            Paths.get(homeDir, ".codeium", "windsurf", "mcp_config.json").toString()

        override fun projectConfigPath(projectRoot: String): String =
            globalConfigPath()

        override fun buildConfigJson(mcps: List<McpEntry>): String {
            val servers = JsonObject()
            for (mcp in mcps) {
                val entry = JsonObject()
                entry.addProperty("command", mcp.server.command)
                val argsArray = JsonArray()
                mcp.server.args.forEach { argsArray.add(resolveArg(it, mcp.env)) }
                entry.add("args", argsArray)
                val envObj = JsonObject()
                mcp.env.forEach { (k, v) -> envObj.addProperty(k, v) }
                if (envObj.size() > 0) entry.add("env", envObj)
                servers.add(mcp.id, entry)
            }
            val root = JsonObject()
            root.add("mcpServers", servers)
            return gson.toJson(root)
        }
    }

    // ── VS Code + GitHub Copilot ───────────────────────────
    private inner class VSCodeAdapter : ConfigAdapter {
        override val agentName = "VS Code / GitHub Copilot"
        override val agentPluginIds = setOf("com.github.copilot")

        override fun globalConfigPath(): String =
            Paths.get(homeDir, ".vscode", "mcp.json").toString()

        override fun projectConfigPath(projectRoot: String): String =
            Paths.get(projectRoot, ".vscode", "mcp.json").toString()

        override fun buildConfigJson(mcps: List<McpEntry>): String {
            val servers = JsonObject()
            for (mcp in mcps) {
                val entry = JsonObject()
                entry.addProperty("type", "stdio")
                entry.addProperty("command", mcp.server.command)
                val argsArray = JsonArray()
                mcp.server.args.forEach { argsArray.add(resolveArg(it, mcp.env)) }
                entry.add("args", argsArray)
                val envObj = JsonObject()
                mcp.env.forEach { (k, v) -> envObj.addProperty(k, v) }
                if (envObj.size() > 0) entry.add("env", envObj)
                servers.add(mcp.id, entry)
            }
            val root = JsonObject()
            root.add("servers", servers)
            return gson.toJson(root)
        }
    }

    // ── Claude Code ────────────────────────────────────────
    private inner class ClaudeAdapter : ConfigAdapter {
        override val agentName = "Claude Code"
        override val agentPluginIds = setOf(
            "com.anthropic.claude", "anthropic.claude", "claude_code_terminal"
        )

        override fun globalConfigPath(): String =
            Paths.get(homeDir, ".claude.json").toString()

        override fun projectConfigPath(projectRoot: String): String =
            Paths.get(projectRoot, ".claude.json").toString()

        override fun buildConfigJson(mcps: List<McpEntry>): String {
            val servers = JsonObject()
            for (mcp in mcps) {
                val entry = JsonObject()
                entry.addProperty("command", mcp.server.command)
                val argsArray = JsonArray()
                mcp.server.args.forEach { argsArray.add(resolveArg(it, mcp.env)) }
                entry.add("args", argsArray)
                val envObj = JsonObject()
                mcp.env.forEach { (k, v) -> envObj.addProperty(k, v) }
                if (envObj.size() > 0) entry.add("env", envObj)
                servers.add(mcp.id, entry)
            }

            val existing = readExistingJson(globalConfigPath())
            existing.add("mcpServers", servers)
            return gson.toJson(existing)
        }
    }

    // ── JetBrains AI Assistant ──────────────────────────────
    private inner class JetBrainsAIAdapter : ConfigAdapter {
        override val agentName = "JetBrains AI Assistant"
        override val agentPluginIds = setOf("com.intellij.ai")

        override fun globalConfigPath(): String =
            Paths.get(homeDir, ".jb-mcp", "mcp.json").toString()

        override fun projectConfigPath(projectRoot: String): String =
            globalConfigPath()

        override fun buildConfigJson(mcps: List<McpEntry>): String {
            val servers = JsonObject()
            for (mcp in mcps) {
                val entry = JsonObject()
                entry.addProperty("command", mcp.server.command)
                val argsArray = JsonArray()
                mcp.server.args.forEach { argsArray.add(resolveArg(it, mcp.env)) }
                entry.add("args", argsArray)
                val envObj = JsonObject()
                mcp.env.forEach { (k, v) -> envObj.addProperty(k, v) }
                if (envObj.size() > 0) entry.add("env", envObj)
                servers.add(mcp.id, entry)
            }
            val root = JsonObject()
            root.add("mcpServers", servers)
            return gson.toJson(root)
        }
    }

    private val adapters: List<ConfigAdapter> = listOf(
        CursorAdapter(),
        WindsurfAdapter(),
        VSCodeAdapter(),
        ClaudeAdapter(),
        JetBrainsAIAdapter()
    )

    fun configure(request: McpConfigureRequest): List<McpWriteResult> {
        val results = mutableListOf<McpWriteResult>()
        val installedAgents = IdeIntegrationService.getInstance().detectInstalledAgents()
        val installedPluginIds = installedAgents.map { it.pluginId }.toSet() +
            installedAgents.map { it.id }.toSet()

        val projectRoot = getProjectRoot()

        for (adapter in adapters) {
            val isInstalled = adapter.agentPluginIds.any { it in installedPluginIds }
            if (!isInstalled) {
                logger.info("Skipping ${adapter.agentName}: not installed")
                continue
            }

            if (request.targetAgents != null) {
                val isTargeted = adapter.agentPluginIds.any { it in request.targetAgents }
                if (!isTargeted) {
                    logger.info("Skipping ${adapter.agentName}: not in targetAgents")
                    continue
                }
            }

            try {
                val configPath = when (request.scope) {
                    "project" -> {
                        if (projectRoot != null) adapter.projectConfigPath(projectRoot)
                        else adapter.globalConfigPath()
                    }
                    else -> adapter.globalConfigPath()
                }

                val configJson = adapter.buildConfigJson(request.mcps)
                writeConfigFile(configPath, configJson)

                results.add(McpWriteResult(
                    agent = adapter.agentName,
                    file = configPath,
                    status = "written"
                ))
                logger.info("Wrote MCP config for ${adapter.agentName}: $configPath")
            } catch (e: Exception) {
                results.add(McpWriteResult(
                    agent = adapter.agentName,
                    file = "",
                    status = "error",
                    error = e.message
                ))
                logger.error("Failed to write MCP config for ${adapter.agentName}", e)
            }
        }

        return results
    }

    private fun writeConfigFile(path: String, content: String) {
        val file = File(path)
        file.parentFile?.mkdirs()

        if (file.exists()) {
            val merged = mergeWithExisting(file, content)
            file.writeText(merged)
        } else {
            file.writeText(content)
        }
    }

    private fun mergeWithExisting(file: File, newContent: String): String {
        return try {
            val existing = gson.fromJson(file.readText(), JsonObject::class.java)
            val incoming = gson.fromJson(newContent, JsonObject::class.java)

            val serverKey = when {
                incoming.has("mcpServers") -> "mcpServers"
                incoming.has("servers") -> "servers"
                else -> return newContent
            }

            val existingServers = existing.getAsJsonObject(serverKey) ?: JsonObject()
            val newServers = incoming.getAsJsonObject(serverKey) ?: JsonObject()

            for (entry in newServers.entrySet()) {
                existingServers.add(entry.key, entry.value)
            }

            existing.add(serverKey, existingServers)
            gson.toJson(existing)
        } catch (e: Exception) {
            logger.warn("Could not merge with existing config, overwriting: ${e.message}")
            newContent
        }
    }

    private fun readExistingJson(path: String): JsonObject {
        return try {
            val file = File(path)
            if (file.exists()) {
                gson.fromJson(file.readText(), JsonObject::class.java) ?: JsonObject()
            } else {
                JsonObject()
            }
        } catch (e: Exception) {
            JsonObject()
        }
    }

    private fun resolveArg(arg: String, env: Map<String, String>): String {
        val regex = Regex("\\$\\{(\\w+)}")
        return regex.replace(arg) { match ->
            val key = match.groupValues[1]
            env[key] ?: match.value
        }
    }

    private fun getProjectRoot(): String? {
        return try {
            val projects = ProjectManager.getInstance().openProjects
            projects.firstOrNull()?.basePath
        } catch (e: Exception) {
            null
        }
    }

    data class ConfiguredMcpInfo(
        val agent: String,
        val mcpIds: List<String>,
        val configFile: String
    )

    fun getConfiguredMcps(): List<ConfiguredMcpInfo> {
        val results = mutableListOf<ConfiguredMcpInfo>()
        val installedAgents = IdeIntegrationService.getInstance().detectInstalledAgents()
        val installedPluginIds = installedAgents.map { it.pluginId }.toSet() +
            installedAgents.map { it.id }.toSet()
        val projectRoot = getProjectRoot()

        for (adapter in adapters) {
            val isInstalled = adapter.agentPluginIds.any { it in installedPluginIds }
            if (!isInstalled) continue

            val paths = mutableListOf(adapter.globalConfigPath())
            if (projectRoot != null) {
                val projPath = adapter.projectConfigPath(projectRoot)
                if (projPath != paths[0]) paths.add(projPath)
            }

            for (configPath in paths) {
                try {
                    val file = File(configPath)
                    if (!file.exists()) continue

                    val json = gson.fromJson(file.readText(), JsonObject::class.java) ?: continue
                    val serverKey = when {
                        json.has("mcpServers") -> "mcpServers"
                        json.has("servers") -> "servers"
                        else -> continue
                    }

                    val servers = json.getAsJsonObject(serverKey) ?: continue
                    val ids = servers.keySet().toList()
                    if (ids.isNotEmpty()) {
                        results.add(ConfiguredMcpInfo(
                            agent = adapter.agentName,
                            mcpIds = ids,
                            configFile = configPath
                        ))
                    }
                } catch (e: Exception) {
                    logger.warn("Failed to read config for ${adapter.agentName} at $configPath: ${e.message}")
                }
            }
        }

        return results
    }

    companion object {
        fun getInstance(): McpConfigWriterService =
            ApplicationManager.getApplication().getService(McpConfigWriterService::class.java)
    }
}
