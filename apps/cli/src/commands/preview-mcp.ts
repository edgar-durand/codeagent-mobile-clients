/**
 * `codeam preview-mcp` — the MCP server that gives every session's agent the
 * in-app Preview as tools.
 *
 * HIDDEN: the agent's MCP config launches it (see `previewMcpServer`), nobody
 * types it. It is a thin stdio front: each tool is one HTTP call to the
 * running CLI's {@link AgentPreviewBridge}, which owns the real pipeline. The
 * bridge address arrives in env; its token in the owner-only MCP secrets file
 * (`integrations/mcp-secrets.ts`) — never argv, never plain env.
 *
 * The tool descriptions ARE the skill: they are always in the agent's context,
 * on every agent, local or managed — which a CLAUDE.md block is not.
 */
import type { McpServerStdio } from '@agentclientprotocol/sdk';
import { mcpSecretEnv } from '../integrations/mcp-secrets';

/** Name the agent sees (tools surface as `mcp__codeagent_preview__*` on Claude). */
export const PREVIEW_MCP_SERVER_NAME = 'codeagent_preview';

export const PREVIEW_IPC_URL_ENV = 'CODEAM_PREVIEW_IPC_URL';
export const PREVIEW_IPC_TOKEN_ENV = 'CODEAM_PREVIEW_IPC_TOKEN';

/** Slightly above the bridge's own `START_WAIT_MS`, so the bridge answers first. */
const START_TIMEOUT_MS = 270_000;
const SHORT_TIMEOUT_MS = 20_000;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const PREVIEW_TOOLS: ToolDef[] = [
  {
    name: 'start_preview',
    description:
      "Open this project's live Preview in the user's CodeAgent app — the same thing as their Preview button: " +
      'it installs dependencies if needed, starts the dev server, publishes it on a public URL and switches the ' +
      "user's screen to it. Use it after you change anything visual (UI, styles, layout, copy) so you and the user " +
      'can check the result, or whenever the user asks to see the app. Returns the public URL (you can curl it) ' +
      'or the exact error. Reuses a preview that is already running. Usually leave the arguments out: the ' +
      'project is detected automatically. Pass command/args/port only if you know the exact dev command.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Dev server executable, e.g. "npm". Optional.' },
        args: { type: 'array', items: { type: 'string' }, description: 'e.g. ["run","dev"]. Optional.' },
        port: { type: 'number', description: 'Port the dev server listens on. Required with command.' },
        framework: { type: 'string', description: 'Label shown to the user, e.g. "next". Optional.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'preview_status',
    description:
      'Current state of the Preview: running (with its URL), starting, error (with the reason) or idle. ' +
      'Use it when start_preview answered that the preview is still starting.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'highlight_element',
    description:
      "Point at an element in the running Preview: the user sees your cursor move to it and a labelled box drawn " +
      'around it, scrolled into view. Use it to show the user exactly what you changed or what you are talking ' +
      'about ("this button", "the header spacing"). Takes a CSS selector (prefer ids, data-testid or specific ' +
      'classes you saw in the code). Several calls add several marks; clear_highlights removes them.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector, e.g. "#checkout" or "[data-testid=hero-cta]".' },
        label: { type: 'string', description: 'Short caption on the mark, e.g. "New CTA". Optional.' },
      },
      required: ['selector'],
      additionalProperties: false,
    },
  },
  {
    name: 'clear_highlights',
    description: 'Remove every mark you drew in the Preview with highlight_element.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'stop_preview',
    description: 'Stop the Preview (dev server + public URL). Only when the user asks, or to restart it cleanly.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

/** The MCP entry for the agent's `session/new`, or null when the bridge isn't up. */
export function previewMcpServer(bridge: { url: string; token: string } | null): McpServerStdio | null {
  if (!bridge) return null;
  return {
    name: PREVIEW_MCP_SERVER_NAME,
    // Same runtime + entrypoint as this CLI — never trust the agent's PATH.
    command: process.execPath,
    args: [process.argv[1], 'preview-mcp'],
    // The token rides the owner-only secrets file, never this env: the
    // claude ACP adapter copies MCP env onto argv (codeagent-5bew).
    env: [{ name: PREVIEW_IPC_URL_ENV, value: bridge.url }, ...mcpSecretEnv('preview', { [PREVIEW_IPC_TOKEN_ENV]: bridge.token })],
  };
}

type Call = (path: string, method: 'GET' | 'POST', body: unknown, timeoutMs: number) => Promise<unknown>;

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

/** Route one tool call to the bridge and phrase the answer for the agent. */
export async function runPreviewTool(
  name: string,
  args: Record<string, unknown>,
  call: Call,
): Promise<{ text: string; isError: boolean }> {
  switch (name) {
    case 'start_preview':
      return describeResult(await call('/preview/start', 'POST', args, START_TIMEOUT_MS));
    case 'preview_status':
      return describeResult(await call('/preview/status', 'GET', undefined, SHORT_TIMEOUT_MS));
    case 'highlight_element':
      return describeAck(await call('/preview/highlight', 'POST', args, SHORT_TIMEOUT_MS));
    case 'clear_highlights':
      return describeAck(await call('/preview/highlight', 'POST', { clear: true }, SHORT_TIMEOUT_MS));
    case 'stop_preview':
      return describeAck(await call('/preview/stop', 'POST', {}, SHORT_TIMEOUT_MS));
    default:
      return { text: `Unknown tool: ${name}`, isError: true };
  }
}

function describeResult(raw: unknown): { text: string; isError: boolean } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  switch (r.status) {
    case 'running': {
      const inspector = r.inspector
        ? ' You can point at elements with highlight_element.'
        : ' (No element highlighting for this framework.)';
      return {
        text:
          `Preview ${r.reused ? 'already running' : 'is live'}: ${String(r.url)} (${String(r.framework)}). ` +
          `The user's app is showing it now.${inspector}`,
        isError: false,
      };
    }
    case 'starting':
      return { text: String(r.message ?? 'The preview is starting.'), isError: false };
    case 'idle':
      return { text: 'No preview is running.', isError: false };
    case 'error':
      return {
        text: `Preview failed at ${String(r.stage)}: ${String(r.message)}`,
        isError: true,
      };
    default:
      return { text: `Unexpected answer from the preview bridge: ${JSON.stringify(raw)}`, isError: true };
  }
}

function describeAck(raw: unknown): { text: string; isError: boolean } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { text: String(r.message ?? r.error ?? 'done'), isError: r.ok !== true };
}

/** Entry point for the hidden `codeam preview-mcp` command. */
export async function previewMcp(): Promise<void> {
  const url = process.env[PREVIEW_IPC_URL_ENV];
  const token = process.env[PREVIEW_IPC_TOKEN_ENV];
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

  const call = url && token ? httpCall(url, token) : null;
  const server = new Server({ name: PREVIEW_MCP_SERVER_NAME, version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: PREVIEW_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (!call) {
      return {
        content: [{ type: 'text' as const, text: 'Preview is not available in this session.' }],
        isError: true,
      };
    }
    try {
      const { text, isError } = await runPreviewTool(
        req.params.name,
        (req.params.arguments ?? {}) as Record<string, unknown>,
        call,
      );
      return { content: [{ type: 'text' as const, text }], isError };
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      return {
        content: [
          {
            type: 'text' as const,
            text: aborted
              ? 'The preview is taking long — it keeps going in the background; call preview_status shortly.'
              : `Preview bridge unreachable: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: !aborted,
      };
    }
  });
  await server.connect(new StdioServerTransport());
}
