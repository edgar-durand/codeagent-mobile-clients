package com.windsurf.controller.services

import com.google.gson.JsonParser
import org.junit.Test
import kotlin.test.assertEquals

class CommandRelayServiceTest {
    @Test
    fun `isTerminal flows through serialized agent payload`() {
        val agents = listOf(
            DetectedAgent("claude_code", "Claude Code", "anthropic.claude-ce", "tw", "claude", true, isTerminal = true),
            DetectedAgent("copilot", "Copilot", "com.github.copilot", "tw", "copilot", true, isTerminal = false),
        )
        val payload = buildAgentsPayload(agents).toString()
        val arr = JsonParser.parseString(payload).asJsonArray
        assertEquals(true, arr[0].asJsonObject.get("isTerminal").asBoolean)
        assertEquals(false, arr[1].asJsonObject.get("isTerminal").asBoolean)
    }
}

class CommandAckPayloadTest {
    @Test
    fun `ack payload carries the plugin id and every delivered command id`() {
        val payload = buildAckPayload("plugin-1", listOf("c1", "c2")).toString()
        val obj = JsonParser.parseString(payload).asJsonObject
        assertEquals("plugin-1", obj.get("pluginId").asString)
        val ids = obj.getAsJsonArray("commandIds")
        assertEquals(2, ids.size())
        assertEquals("c1", ids[0].asString)
        assertEquals("c2", ids[1].asString)
    }
}
