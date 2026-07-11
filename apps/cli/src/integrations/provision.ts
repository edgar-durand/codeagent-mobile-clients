// src/integrations/provision.ts
//
// Builds the ACP `mcpServers` list from the Agent Toolkits integrations
// manifest (`~/.codeam/integrations.json`) for a session about to spawn.
// Pure/synchronous file work — it never fetches a broker token itself; the
// `codeam mcp-run <id>` shim (spawned as the MCP server's `command`) brokers
// the short-lived credential lazily at MCP-session-start, not here. This
// keeps agent spawn on the fast path and never blocks it: any miss (no
// manifest, no plugin auth token, an entry without an `mcp` delivery) simply
// yields fewer/zero servers.
import type { McpServer } from '@agentclientprotocol/sdk';
import { readIntegrationsManifest } from './manifest';
import { log } from '../services/logger';

export interface ProvisionCtx {
  sessionId: string;
  pluginId: string;
  /** Per-pairing secret. Required to inject any MCP server — without it the
   *  shim has no credential broker to call, so injection is skipped. */
  pluginAuthToken?: string;
  /** Replayed to the gated `/api/pairing/reconnect` token-refresh path. */
  pollSecret?: string;
}

/**
 * Reads `~/.codeam/integrations.json` and builds one ACP `McpServerStdio`
 * spec per manifest entry that declares an `mcp` delivery, each pointing at
 * the self-invoked shim (`codeam mcp-run <id>`) rather than the integration's
 * real launcher — the shim resolves the real command/args/token at its own
 * spawn time. Returns `[]` on any miss (no manifest, no plugin auth token) —
 * this must never block agent start.
 */
export function buildMcpServersForStart(ctx: ProvisionCtx): McpServer[] {
  const manifest = readIntegrationsManifest();
  if (!manifest || manifest.integrations.length === 0) return [];
  if (!ctx.pluginAuthToken) {
    log.warn('integrations', 'manifest present but no plugin auth token — skipping MCP injection');
    return [];
  }

  const servers: McpServer[] = [];
  for (const entry of manifest.integrations) {
    if (!entry.delivery.mcp) continue;
    const env = [
      { name: 'CODEAM_MCP_INTEGRATION_ID', value: entry.id },
      { name: 'CODEAM_MCP_SESSION_ID', value: ctx.sessionId },
      { name: 'CODEAM_MCP_PLUGIN_ID', value: ctx.pluginId },
      // Plugin token in ENV, never argv — argv is visible via `ps`.
      { name: 'CODEAM_MCP_PLUGIN_TOKEN', value: ctx.pluginAuthToken },
      ...(ctx.pollSecret ? [{ name: 'CODEAM_MCP_POLL_SECRET', value: ctx.pollSecret }] : []),
    ];
    servers.push({
      name: entry.id,
      // Never trust the agent's PATH for the shim binary (beads v2.39.5
      // lesson) — re-invoke this same Node runtime + CLI entrypoint.
      command: process.execPath,
      args: [process.argv[1], 'mcp-run', entry.id],
      env,
    });
  }

  if (servers.length) {
    log.info(
      'integrations',
      `injecting ${servers.length} MCP server(s): ${servers.map((s) => s.name).join(', ')}`,
    );
  }
  return servers;
}
