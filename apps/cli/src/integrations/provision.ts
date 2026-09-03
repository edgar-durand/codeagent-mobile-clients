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
import { MCP_ROUTER_SERVER_NAME } from './mcp-router';
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

  // ⚠️ Router opt-in. When the backend-resolved manifest says `toolRouter`, the
  // agent gets ONE server — `codeam mcp-router` — instead of every integration
  // server. The router spawns exactly these same `mcp-run <id>` shims itself
  // (same env, same broker, same watchdogs), so nothing below this line about
  // credentials or process trees changes; only what the agent's context
  // carries does: 4 tool schemas instead of hundreds. See mcp-router.ts for
  // the measurement that made this necessary. Without the flag, behaviour is
  // byte-identical to before.
  if (manifest.toolRouter === true && servers.length > 0) {
    const routed = servers.map((s) => s.name);
    log.info(
      'integrations',
      `tool router ON — fronting ${routed.length} MCP server(s) behind one: ${routed.join(', ')}`,
    );
    return [
      {
        name: MCP_ROUTER_SERVER_NAME,
        command: process.execPath,
        args: [process.argv[1], 'mcp-router'],
        // The router re-spawns each shim with THIS env: the same session /
        // plugin id / token / secret the shims got when injected directly.
        // No per-integration id — each child receives its own via
        // `mcp-run <id>` argv, which the shim prefers.
        env: [
          { name: 'CODEAM_MCP_SESSION_ID', value: ctx.sessionId },
          { name: 'CODEAM_MCP_PLUGIN_ID', value: ctx.pluginId },
          { name: 'CODEAM_MCP_PLUGIN_TOKEN', value: ctx.pluginAuthToken },
          ...(ctx.pollSecret ? [{ name: 'CODEAM_MCP_POLL_SECRET', value: ctx.pollSecret }] : []),
        ],
      },
    ];
  }

  if (servers.length) {
    log.info(
      'integrations',
      `injecting ${servers.length} MCP server(s): ${servers.map((s) => s.name).join(', ')}`,
    );
  }
  return servers;
}
