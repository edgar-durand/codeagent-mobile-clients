import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { IntegrationsManifest } from '@codeam/shared';

/**
 * The router, END TO END, with nothing mocked in the code under test:
 *
 *   agent (this test, an MCP client over stdio)
 *     └─ `codeam mcp-router`                      ← the real router process
 *          ├─ `codeam mcp-run alpha`              ← the real shim
 *          │     └─ brokers its token from a FAKE backend (real http server)
 *          │     └─ spawns FAKE_SERVER "alpha"     ← a real MCP server (SDK) with 2 tools
 *          ├─ `codeam mcp-run beta`  → FAKE_SERVER "beta" with 1 tool
 *          └─ `codeam mcp-run broken` → a server that exits at once
 *
 * What it proves, in the order the incident taught it matters:
 *   1. the agent sees FOUR tools, not three — the whole point;
 *   2. `search_tools` finds the children's tools, qualified `<integration>/<tool>`;
 *   3. `call_tool` reaches the RIGHT child and returns ITS content verbatim;
 *   4. a broken child does not take the router down — it is reported as
 *      unavailable and the healthy ones keep working (the same degraded state
 *      the agent had before, never worse).
 *
 * Gated on RUN_MCP_INT=1: it spawns real processes and takes a few seconds.
 */

const enabled = process.env.RUN_MCP_INT === '1';
const CLI_ENTRY = resolve(__dirname, '../../dist/index.js');

// A real MCP server (the SDK's own) exposing the tools named in argv, each
// echoing its arguments and its own name — so `call_tool` provably reached the
// right child. Also reports the credential env the shim mapped, to prove the
// broker path ran.
const FAKE_SERVER = String.raw`
  const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
  const [me, ...toolNames] = process.argv.slice(2);
  const s = new Server({ name: me, version: '0' }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolNames.map((n) => ({ name: n, description: me + ' does ' + n.replace(/_/g, ' '), inputSchema: { type: 'object', properties: { x: { type: 'string' } } } })),
  }));
  s.setRequestHandler(CallToolRequestSchema, async (req) => ({
    content: [{ type: 'text', text: JSON.stringify({ served_by: me, tool: req.params.name, args: req.params.arguments ?? {}, token_env: process.env.FAKE_TOKEN ?? null }) }],
  }));
  s.connect(new StdioServerTransport());
`;

let home: string;
let broker: Server;
let brokerCalls: string[] = [];
const origEnv = { ...process.env };

function manifest(fakeServerFile: string): IntegrationsManifest {
  const mcp = (args: string[]) => ({
    command: process.execPath,
    args: [fakeServerFile, ...args],
    envMapping: { FAKE_TOKEN: 'accessToken' },
  });
  return {
    toolRouter: true,
    integrations: [
      { id: 'alpha', delivery: { mcp: mcp(['alpha', 'create_thing', 'list_things']) } },
      { id: 'beta', delivery: { mcp: mcp(['beta', 'send_ping']) } },
      // A server that dies immediately — `node -e "process.exit(3)"`.
      { id: 'broken', delivery: { mcp: { command: process.execPath, args: ['-e', 'process.exit(3)'], envMapping: {} } } },
    ] as unknown as IntegrationsManifest['integrations'],
  };
}

/** Minimal MCP client over stdio — enough to drive the router like an agent. */
class MiniClient {
  private buf = '';
  private id = 0;
  private waiters = new Map<number, (v: unknown) => void>();
  constructor(private readonly child: ChildProcess) {
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (c: string) => {
      this.buf += c;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl); this.buf = this.buf.slice(nl + 1);
        try { const j = JSON.parse(line); if (typeof j.id === 'number' && this.waiters.has(j.id)) { this.waiters.get(j.id)!(j); this.waiters.delete(j.id); } } catch { /* notification / partial */ }
      }
    });
  }
  request(method: string, params: unknown = {}, timeoutMs = 60_000): Promise<{ result?: unknown; error?: unknown }> {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.waiters.delete(id); rej(new Error(`${method} timed out`)); }, timeoutMs);
      this.waiters.set(id, (v) => { clearTimeout(t); res(v as never); });
      this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  notify(method: string, params: unknown = {}): void { this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'mcp-router-int-'));
  mkdirSync(join(home, '.codeam'), { recursive: true });
  const fakeServerFile = join(home, 'fake-server.cjs');
  writeFileSync(fakeServerFile, FAKE_SERVER);
  writeFileSync(join(home, '.codeam', 'integrations.json'), JSON.stringify(manifest(fakeServerFile)));

  // The credential broker the shim calls: a real HTTP server handing out a
  // token per integration and recording who asked.
  broker = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
      const m = /\/api\/plugin\/integrations\/([^/]+)\/token/.exec(req.url ?? '');
      if (!m) { res.writeHead(404); res.end(); return; }
      brokerCalls.push(m[1]);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { accessToken: `tok-${m[1]}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }));
    });
  });
  await new Promise<void>((ok) => broker.listen(0, '127.0.0.1', ok));
  const port = (broker.address() as { port: number }).port;
  process.env.HOME = home; process.env.USERPROFILE = home;
  process.env.CODEAM_API_URL = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  await new Promise<void>((ok) => broker.close(() => ok()));
  for (const k of Object.keys(process.env)) if (!(k in origEnv)) delete process.env[k];
  Object.assign(process.env, origEnv);
});

describe.runIf(enabled)('codeam mcp-router — end to end over real processes', () => {
  it('fronts N real integration servers behind FOUR tools and forwards calls to the right child', async () => {
    const child = spawn(process.execPath, [CLI_ENTRY, 'mcp-router'], {
      env: {
        ...process.env,
        CODEAM_MCP_SESSION_ID: 'sess-1', CODEAM_MCP_PLUGIN_ID: 'plug-1', CODEAM_MCP_PLUGIN_TOKEN: 'v1.plugin',
        // `require('@modelcontextprotocol/sdk/...')` inside the fake servers must resolve from the repo.
        NODE_PATH: resolve(__dirname, '../../../../node_modules'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = ''; child.stderr!.setEncoding('utf8'); child.stderr!.on('data', (c: string) => (stderr += c));
    const c = new MiniClient(child);
    try {
      const init = await c.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent', version: '0' } }, 120_000);
      expect(init.error, JSON.stringify(init.error)).toBeUndefined();
      c.notify('notifications/initialized');

      // 1. FOUR tools, whatever the children expose (3 real ones here, 475 on a real box).
      const list = (await c.request('tools/list')).result as { tools: Array<{ name: string }> };
      expect(list.tools.map((t) => t.name).sort()).toEqual(['call_tool', 'describe_tool', 'list_integrations', 'search_tools']);

      // 4. the broken child is reported, not fatal.
      const li = JSON.parse(((await c.request('tools/call', { name: 'list_integrations', arguments: {} })).result as { content: Array<{ text: string }> }).content[0].text) as Array<{ integration: string; available: boolean; tools: number }>;
      const byId = Object.fromEntries(li.map((x) => [x.integration, x]));
      expect(byId.alpha).toMatchObject({ available: true, tools: 2 });
      expect(byId.beta).toMatchObject({ available: true, tools: 1 });
      expect(byId.broken.available).toBe(false);

      // 2. search finds the children's tools, qualified.
      const hits = JSON.parse(((await c.request('tools/call', { name: 'search_tools', arguments: { query: 'create' } })).result as { content: Array<{ text: string }> }).content[0].text) as Array<{ tool: string }>;
      expect(hits.map((h) => h.tool)).toEqual(['alpha/create_thing']);

      // describe returns the child's own schema.
      const desc = JSON.parse(((await c.request('tools/call', { name: 'describe_tool', arguments: { tool: 'beta/send_ping' } })).result as { content: Array<{ text: string }> }).content[0].text) as { inputSchema: { properties: unknown } };
      expect(desc.inputSchema.properties).toEqual({ x: { type: 'string' } });

      // 3. call reaches the RIGHT child, with the arguments, and returns its content verbatim —
      //    and the shim brokered that child's credential on the way (token_env set from the broker).
      const call = (await c.request('tools/call', { name: 'call_tool', arguments: { tool: 'beta/send_ping', arguments: { x: 'hello' } } })).result as { content: Array<{ text: string }>; isError?: boolean };
      expect(call.isError).not.toBe(true);
      expect(JSON.parse(call.content[0].text)).toEqual({ served_by: 'beta', tool: 'send_ping', args: { x: 'hello' }, token_env: 'tok-beta' });
      expect(brokerCalls).toContain('alpha'); expect(brokerCalls).toContain('beta');

      // Bad names fail with guidance, never a crash.
      const bad = (await c.request('tools/call', { name: 'call_tool', arguments: { tool: 'nope' } })).result as { isError: boolean; content: Array<{ text: string }> };
      expect(bad.isError).toBe(true); expect(bad.content[0].text).toMatch(/search_tools/);
      const gone = (await c.request('tools/call', { name: 'call_tool', arguments: { tool: 'broken/anything' } })).result as { isError: boolean; content: Array<{ text: string }> };
      expect(gone.isError).toBe(true); expect(gone.content[0].text).toMatch(/unavailable/);
    } finally {
      child.kill('SIGKILL');
      if (process.env.DEBUG_ROUTER) console.error(stderr);
    }
  }, 180_000);
});
