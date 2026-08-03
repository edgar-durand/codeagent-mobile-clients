// src/integrations/convex-admin-mcp.ts
//
// A BUILT-IN (codeam-authored) MCP server for Convex — the reason it exists:
// Convex's own `convex mcp start` server hard-requires an INTERACTIVE
// `npx convex dev`/`login` personal-access-token and REJECTS every headless
// credential (OAuth token, dev/prod deploy key, self-hosted admin key — all
// return "Not Authorized: Run `npx convex dev` to login"; verified live
// 2026-08-03). That makes it unusable under our headless brokered-credential
// model, and worse it HANGS on the failed auth (the mareado/no-Stop wedge).
//
// BUT the Convex deployment's own HTTP admin API accepts the deploy key
// directly (`Authorization: Convex <deployKey>` → 200; verified). So this MCP
// exposes the useful Convex tools and fulfils them by calling the deployment's
// admin REST API with the brokered deploy key — no `convex` CLI, no cloud login.
//
// Follows the `http-relay.ts` precedent: uses `@modelcontextprotocol/sdk` on the
// STDIO server side to talk to the agent; the tool handlers are the new part.
import { IntegrationTokenClient } from './token-client';

/** Derive the deployment name from a Convex deploy key: `dev:famous-skunk-76|…`
 *  / `prod:happy-animal-1|…` → the deployment name (the *.convex.cloud host). */
export function deploymentNameFromKey(key: string): string | null {
  const prefix = key.split('|')[0]; // e.g. "dev:famous-skunk-76"
  const segs = prefix.split(':');
  // dev/prod deploy keys are `<type>:<name>`; the name is the 2nd segment.
  if ((segs[0] === 'dev' || segs[0] === 'prod' || segs[0] === 'preview') && segs[1]) {
    return segs[1];
  }
  return null;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'tables',
    description:
      'List the tables in the connected Convex deployment (name + id). Start here to discover the schema.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'schema',
    description: 'Get the deployed schema (table definitions + validators) of the Convex deployment.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'data',
    description: 'Read documents from a table (most-recent first). Provide the table name.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'The table name (from `tables`).' },
        limit: { type: 'number', description: 'Max documents to return (default 50).' },
      },
      required: ['table'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_query',
    description:
      'Run a read-only Convex query function by its path (e.g. "messages:list") with JSON args.',
    inputSchema: {
      type: 'object',
      properties: {
        functionPath: { type: 'string', description: 'Function path, e.g. "messages:list".' },
        args: { type: 'object', description: 'Arguments object for the function (default {}).' },
      },
      required: ['functionPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_mutation',
    description: 'Run a Convex mutation function by its path with JSON args (writes data).',
    inputSchema: {
      type: 'object',
      properties: {
        functionPath: { type: 'string' },
        args: { type: 'object' },
      },
      required: ['functionPath'],
      additionalProperties: false,
    },
  },
];

/** POST to the deployment admin API with the deploy key as the admin credential. */
async function adminQuery(
  baseUrl: string,
  key: string,
  api: 'query' | 'mutation',
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; text: string }> {
  const res = await fetchImpl(`${baseUrl}/api/${api}`, {
    method: 'POST',
    headers: { Authorization: `Convex ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // Convex returns HTTP 200 with `{"status":"error",...}` for UDF-level errors.
  const ok = res.ok && !/"status"\s*:\s*"error"/.test(text);
  return { ok, text };
}

/** Dispatch one tool call to the Convex admin API. Pure (fetch injectable) so it
 *  is unit-testable without a live deployment. */
export async function callConvexTool(
  baseUrl: string,
  key: string,
  tool: string,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; text: string }> {
  switch (tool) {
    case 'tables':
      return adminQuery(baseUrl, key, 'query', {
        path: '_system/frontend/getTableMapping',
        args: {},
        format: 'json',
      }, fetchImpl);
    case 'schema':
      return adminQuery(baseUrl, key, 'query', {
        path: '_system/frontend/getSchemas',
        args: {},
        format: 'json',
      }, fetchImpl);
    case 'data':
      return adminQuery(baseUrl, key, 'query', {
        path: '_system/cli/queryTable',
        args: { tableName: String(args.table ?? ''), order: 'desc', limit: Number(args.limit ?? 50) },
        format: 'json',
      }, fetchImpl);
    case 'run_query':
      return adminQuery(baseUrl, key, 'query', {
        path: String(args.functionPath ?? ''),
        args: (args.args as Record<string, unknown>) ?? {},
        format: 'json',
      }, fetchImpl);
    case 'run_mutation':
      return adminQuery(baseUrl, key, 'mutation', {
        path: String(args.functionPath ?? ''),
        args: (args.args as Record<string, unknown>) ?? {},
        format: 'json',
      }, fetchImpl);
    default:
      return { ok: false, text: `Unknown tool: ${tool}` };
  }
}

/**
 * Run the built-in Convex admin MCP over stdio for the lifetime of the session.
 * Brokers the deploy key, derives the deployment URL, and serves the tools.
 */
export async function runConvexAdminMcp(client: IntegrationTokenClient, id: string): Promise<void> {
  const token = await client.getToken(id);
  const key = token.accessToken;
  const name = deploymentNameFromKey(key);
  if (!name) {
    process.stderr.write(
      `[codeam mcp-run convex] could not derive a deployment from the deploy key ` +
        `(expected a dev/prod deploy key like dev:name|… — got prefix "${key.split(':')[0]}"). ` +
        `Generate a deploy key at Convex Dashboard → Project Settings → Deploy Keys.\n`,
    );
    process.exit(1);
  }
  const baseUrl = `https://${name}.convex.cloud`;

  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import(
    '@modelcontextprotocol/sdk/types.js'
  );

  const server = new Server(
    { name: 'convex', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const { ok, text } = await callConvexTool(baseUrl, key, tool, args);
      return { content: [{ type: 'text', text }], isError: !ok };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Convex admin API request failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  });

  await server.connect(new StdioServerTransport());
  // The transport keeps the process alive until the agent closes stdin.
}
