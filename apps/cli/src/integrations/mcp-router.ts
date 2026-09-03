// src/integrations/mcp-router.ts
//
// `codeam mcp-router` — ONE MCP server that fronts every integration MCP server
// of a session, so the agent carries FOUR tool schemas instead of hundreds.
//
// ⚠️ WHY. Every MCP tool definition the agent is given travels in the request
// on EVERY turn, and compaction cannot shrink it — schemas are not history.
// Measured on a real box with 14 linked integrations (2026-09-03):
//
//     postman 42 tools ≈ 41.6k tokens · jira 90 ≈ 35.4k · clickup 162 ≈ 32.9k ·
//     resend 77 ≈ 25.2k · notion 24 ≈ 20.5k · …  TOTAL 475 tools ≈ 175k tokens
//
// On the house agent (MiniMax through our proxy) that is most of the window
// before the user types a word, and the session autocompact-thrashed: 13
// compactions, one triggered by a 28-character prompt. Claude Code's own remedy
// — deferred tool loading (`ENABLE_TOOL_SEARCH`, `tool_reference` blocks) — is
// DISABLED for any non-Anthropic `ANTHROPIC_BASE_URL`, and MiniMax rejects the
// blocks outright (`function name is empty (2013)`, probed live). So the
// deferral has to be ours.
//
// This is that deferral. The agent sees:
//   list_integrations   — which integrations are attached, and how many tools each has
//   search_tools        — find tools by keyword/integration; returns name + description
//   describe_tool       — the FULL input schema of one tool, on demand
//   call_tool           — invoke `<integration>/<tool>` with arguments
// Behind them, the router spawns the SAME `codeam mcp-run <id>` shims the
// agent used to spawn directly (credential broker, token refresh, tool-call
// watchdog, pre-warmed packages — all unchanged) and talks to them as an MCP
// client. Nothing is re-implemented; the servers do not know they are fronted.
//
// ⚠️ SAFETY RAILS, because this replaces how tools reach the agent:
//   - The router is only used when the backend-resolved manifest OPTS IN
//     (`toolRouter: true`); absent that flag, `buildMcpServersForStart`
//     behaves exactly as before — every server injected directly. Rollout can
//     be scoped (house agent first) and reverted from the backend alone.
//   - Box-local MCP servers (`~/.codeam/mcp-servers.json`) are NOT routed; they
//     are merged next to the router exactly as they were merged next to the
//     integration servers. A user's own servers keep their own tool names.
//   - A child server that fails to start does not fail the router: its tools
//     are simply absent, and `list_integrations` reports it as unavailable —
//     the same degraded state the agent had before ("not connected").
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { log } from '../services/logger';
import { readIntegrationsManifest } from './manifest';

/** The ID under which the router itself is advertised to the agent. */
export const MCP_ROUTER_SERVER_NAME = 'codeam';

/** Hard ceiling on a single forwarded `tools/call`; mirrors the shim's own
 *  watchdog so a wedged server cannot wedge the agent through us either. */
const CALL_TIMEOUT_MS = (() => {
  const raw = Number(process.env.CODEAM_MCP_TOOL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
})();

/** How long one child server gets to answer `initialize` + `tools/list`. */
const CHILD_START_TIMEOUT_MS = 90_000;

export interface RoutedTool {
  integration: string;
  name: string;
  description: string;
  inputSchema: unknown;
}

interface ChildState {
  id: string;
  client: Client | null;
  tools: RoutedTool[];
  error: string | null;
}

/** `<integration>/<tool>` — the one identifier the agent uses with `call_tool`. */
export function qualifiedName(integration: string, tool: string): string {
  return `${integration}/${tool}`;
}

export function splitQualifiedName(q: string): { integration: string; tool: string } | null {
  const i = q.indexOf('/');
  if (i <= 0 || i === q.length - 1) return null;
  return { integration: q.slice(0, i), tool: q.slice(i + 1) };
}

/**
 * Case-insensitive keyword match over name + description, optionally scoped to
 * one integration. Every keyword must match (AND), so "create task" narrows
 * rather than widens. Pure, so the ranking is testable without any server.
 */
export function searchTools(tools: readonly RoutedTool[], query: string, integration?: string): RoutedTool[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tools
    .filter((t) => !integration || t.integration === integration)
    .filter((t) => {
      if (words.length === 0) return true;
      const hay = `${t.integration} ${t.name} ${t.description}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => {
      // Name hits outrank description hits so `search_tools("create_task")`
      // puts the tool called create_task first, not one that mentions it.
      const an = words.some((w) => a.name.toLowerCase().includes(w)) ? 0 : 1;
      const bn = words.some((w) => b.name.toLowerCase().includes(w)) ? 0 : 1;
      return an - bn || a.integration.localeCompare(b.integration) || a.name.localeCompare(b.name);
    });
}

/** The four schemas the agent carries instead of every integration's. */
export function routerToolDefinitions(): Array<{ name: string; description: string; inputSchema: unknown }> {
  return [
    {
      name: 'list_integrations',
      description:
        'List the integrations attached to this session (Jira, Linear, ClickUp, Postman, …) with how many tools each exposes and whether it is available. Call this first when the user asks what you can do with an external service.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'search_tools',
      description:
        'Search the tools of the attached integrations by keywords (e.g. "create task", "list boards", "send email"). Returns each match as `<integration>/<tool>` with a one-line description. Use `describe_tool` for the full argument schema, then `call_tool` to run it.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords to match against tool names and descriptions.' },
          integration: { type: 'string', description: 'Optional: restrict to one integration id, e.g. "clickup".' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'describe_tool',
      description: 'Return the full JSON input schema of one tool, given its `<integration>/<tool>` name from `search_tools`.',
      inputSchema: {
        type: 'object',
        properties: { tool: { type: 'string', description: '`<integration>/<tool>`, e.g. "clickup/create_task".' } },
        required: ['tool'],
        additionalProperties: false,
      },
    },
    {
      name: 'call_tool',
      description: 'Invoke one integration tool by its `<integration>/<tool>` name with the arguments its schema expects. The result is returned verbatim from the integration.',
      inputSchema: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: '`<integration>/<tool>`.' },
          arguments: { type: 'object', description: 'Arguments matching the schema from `describe_tool`.', additionalProperties: true },
        },
        required: ['tool'],
        additionalProperties: false,
      },
    },
  ];
}

/** The two SDK constructors the router needs; injected so tests can hand in
 *  fakes without spawning anything. */
export interface RouterSdk {
  Client: typeof Client;
  StdioClientTransport: typeof StdioClientTransport;
}

/**
 * Spawn `codeam mcp-run <id>` for one integration and connect as an MCP client.
 * Returns the child's tools, or an error string — never throws, so one broken
 * integration cannot take the router down with it.
 */
export async function startChild(id: string, env: NodeJS.ProcessEnv, sdk: RouterSdk): Promise<ChildState> {
  const state: ChildState = { id, client: null, tools: [], error: null };
  const timer = new Promise<never>((_, rej) => {
    const t = setTimeout(
      () => rej(new Error(`timed out after ${CHILD_START_TIMEOUT_MS / 1000}s starting`)),
      CHILD_START_TIMEOUT_MS,
    );
    t.unref?.();
  });
  try {
    // Same spawn shape the agent used: this node binary, this CLI entrypoint,
    // `mcp-run <id>`, with the shim's env (session, plugin token, poll secret).
    const transport = new sdk.StdioClientTransport({
      command: process.execPath,
      args: [process.argv[1], 'mcp-run', id],
      env: Object.fromEntries(
        Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string'),
      ),
      stderr: 'inherit',
    });
    const client = new sdk.Client({ name: 'codeam-router', version: '1.0.0' }, { capabilities: {} });
    await Promise.race([client.connect(transport), timer]);
    const listed = await Promise.race([client.listTools(), timer]);
    state.client = client;
    state.tools = listed.tools.map((t) => ({
      integration: id,
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema,
    }));
    log.info('mcpRouter', `${id}: ${state.tools.length} tool(s) ready`);
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    log.warn('mcpRouter', `${id}: unavailable — ${state.error}`);
  }
  return state;
}

/**
 * Run the router as a stdio MCP server. The agent talks to us; we talk to the
 * shims. Never returns while the agent holds our stdin open.
 */
export async function mcpRouter(): Promise<void> {
  const manifest = readIntegrationsManifest();
  const ids = (manifest?.integrations ?? []).filter((e) => e.delivery?.mcp).map((e) => e.id);

  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const { Client: ClientCtor } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport: TransportCtor } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const sdk: RouterSdk = { Client: ClientCtor, StdioClientTransport: TransportCtor };

  // Start every child in parallel — the agent's own `session/new` used to do
  // exactly this, so the box's load profile is unchanged; only the schemas the
  // agent carries afterwards are different.
  const children = await Promise.all(ids.map((id) => startChild(id, process.env, sdk)));
  const byId = new Map(children.map((c) => [c.id, c]));
  const allTools = children.flatMap((c) => c.tools);
  log.info('mcpRouter', `fronting ${children.filter((c) => c.client).length}/${ids.length} integration server(s), ${allTools.length} tools behind 4`);

  const server = new Server({ name: MCP_ROUTER_SERVER_NAME, version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: routerToolDefinitions() }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const text = (v: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }], isError });

    if (name === 'list_integrations') {
      return text(children.map((c) => ({ integration: c.id, available: c.client !== null, tools: c.tools.length, ...(c.error ? { error: c.error } : {}) })));
    }
    if (name === 'search_tools') {
      const q = typeof args.query === 'string' ? args.query : '';
      const integration = typeof args.integration === 'string' ? args.integration : undefined;
      const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(50, args.limit)) : 20;
      const hits = searchTools(allTools, q, integration).slice(0, limit);
      return text(hits.map((t) => ({ tool: qualifiedName(t.integration, t.name), description: t.description })));
    }
    if (name === 'describe_tool' || name === 'call_tool') {
      const q = typeof args.tool === 'string' ? args.tool : '';
      const parts = splitQualifiedName(q);
      if (!parts) return text(`Expected "<integration>/<tool>", got "${q}". Use search_tools to find the name.`, true);
      const child = byId.get(parts.integration);
      if (!child) return text(`No integration "${parts.integration}" is attached to this session. Use list_integrations.`, true);
      if (!child.client) return text(`Integration "${parts.integration}" is unavailable: ${child.error ?? 'failed to start'}.`, true);
      const tool = child.tools.find((t) => t.name === parts.tool);
      if (!tool) return text(`No tool "${parts.tool}" in "${parts.integration}". Use search_tools.`, true);
      if (name === 'describe_tool') return text({ tool: q, description: tool.description, inputSchema: tool.inputSchema });
      const timer = new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`"${q}" did not answer within ${CALL_TIMEOUT_MS / 1000}s`)), CALL_TIMEOUT_MS).unref?.());
      try {
        const res = (await Promise.race([
          child.client.callTool({ name: parts.tool, arguments: (args.arguments as Record<string, unknown>) ?? {} }),
          timer,
        ])) as { content?: unknown; isError?: boolean };
        // Forward the integration's content verbatim — the agent reads it as if
        // it had called the server directly.
        return { content: (res.content as never) ?? [], isError: res.isError === true };
      } catch (err) {
        return text(`${q} failed: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    }
    return text(`Unknown tool "${name}".`, true);
  });

  await server.connect(new StdioServerTransport());
  // Children die with us: the agent closes our stdin → transport closes → the
  // process exits → each StdioClientTransport's child loses ITS stdin.
  process.stdin.on('close', () => {
    for (const c of children) void c.client?.close().catch(() => undefined);
  });
}
