/**
 * `codeam scratch-mcp` — the MCP server that steers a from-scratch session's
 * agent towards offering the user a save prompt.
 *
 * HIDDEN, and injected ONLY into scratch sessions (see `scratchMcpServer`,
 * wired via `ProvisionCtx.scratch`): nobody types it. Modelled line-for-line
 * on `preview-mcp.ts` — a thin stdio front whose one tool is an HTTP call to
 * the running CLI's `AgentPreviewBridge` loopback (the same bridge/token the
 * Preview tools use), which relays it to the backend. It never saves
 * anything itself: the tool only asks the app to show the "Save your
 * project" card.
 *
 * The tool description IS the skill: it's always in the agent's context, on
 * every agent, local or managed — which a CLAUDE.md block is not.
 */
import type { McpServerStdio } from '@agentclientprotocol/sdk';
import { mcpSecretEnv } from '../integrations/mcp-secrets';

/** Name the agent sees (tools surface as `mcp__codeagent_scratch__*` on Claude). */
export const SCRATCH_MCP_SERVER_NAME = 'codeagent_scratch';

export const SCRATCH_IPC_URL_ENV = 'CODEAM_SCRATCH_IPC_URL';
export const SCRATCH_IPC_TOKEN_ENV = 'CODEAM_SCRATCH_IPC_TOKEN';

const CALL_TIMEOUT_MS = 10_000;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const SCRATCH_TOOLS: ToolDef[] = [
  {
    name: 'suggest_save_project',
    description: [
      "This session is a from-scratch project on the user's CodeAgent Box. It is NOT connected to GitHub, and nothing is saved outside this workspace yet.",
      'How to work here: build something small, visible and working. As soon as it can be seen, start it with the codeagent_preview start_preview tool and tell the user the preview is open.',
      'Once the user has seen something working — or after a substantial change that is not saved yet — call this tool ONCE. It shows the user a "Save your project" card in the app (Save to GitHub or Download ZIP).',
      "Do not push, create repositories or ask for GitHub credentials yourself: saving is the user's choice in the app. Do not call this tool again unless there are substantial new unsaved changes.",
    ].join(' '),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

/** The MCP entry for the agent's `session/new`, or null when the bridge isn't up. */
export function scratchMcpServer(bridge: { url: string; token: string } | null): McpServerStdio | null {
  if (!bridge) return null;
  return {
    name: SCRATCH_MCP_SERVER_NAME,
    // Same runtime + entrypoint as this CLI — never trust the agent's PATH.
    command: process.execPath,
    args: [process.argv[1], 'scratch-mcp'],
    // The token rides the owner-only secrets file, never this env: the
    // claude ACP adapter copies MCP env onto argv (codeagent-5bew).
    env: [
      { name: SCRATCH_IPC_URL_ENV, value: bridge.url },
      ...mcpSecretEnv('scratch', { [SCRATCH_IPC_TOKEN_ENV]: bridge.token }),
    ],
  };
}

export type Call = (path: string, method: 'GET' | 'POST', body: unknown, timeoutMs: number) => Promise<unknown>;

function httpCall(baseUrl: string, token: string): Call {
  return async (path, method, body, timeoutMs) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
        signal: ac.signal,
      });
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Route the one tool call to the bridge and phrase the answer for the agent. */
export async function runScratchTool(
  name: string,
  _args: unknown,
  call: Call,
): Promise<{ text: string; isError: boolean }> {
  if (name !== 'suggest_save_project') return { text: `Unknown tool ${name}`, isError: true };
  try {
    const r = (await call('/scratch/save-offer', 'POST', {}, CALL_TIMEOUT_MS)) as { offered?: boolean };
    return r?.offered
      ? { text: 'The save card is now shown to the user in the app.', isError: false }
      : { text: 'Could not show the save card right now; continue working and try again later.', isError: true };
  } catch (err) {
    return { text: `Could not reach the session: ${(err as Error).message}`, isError: true };
  }
}

/** Entry point for the hidden `codeam scratch-mcp` command. */
export async function scratchMcp(): Promise<void> {
  const url = process.env[SCRATCH_IPC_URL_ENV];
  const token = process.env[SCRATCH_IPC_TOKEN_ENV];
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

  const call = url && token ? httpCall(url, token) : null;
  const server = new Server({ name: SCRATCH_MCP_SERVER_NAME, version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: SCRATCH_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (!call) {
      return {
        content: [{ type: 'text' as const, text: 'Save is not available in this session.' }],
        isError: true,
      };
    }
    try {
      const { text, isError } = await runScratchTool(req.params.name, req.params.arguments ?? {}, call);
      return { content: [{ type: 'text' as const, text }], isError };
    } catch (err) {
      return {
        content: [
          { type: 'text' as const, text: `Save bridge unreachable: ${err instanceof Error ? err.message : String(err)}` },
        ],
        isError: true,
      };
    }
  });
  await server.connect(new StdioServerTransport());
}
