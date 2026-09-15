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
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
  {
    name: 'deploy',
    description:
      'Deploy this repo\'s `convex/` functions, schema and indexes to the Convex deployment ' +
      'this integration is connected to. Use this after editing anything under `convex/` — ' +
      'a function you just wrote does NOT exist for the running app until it is deployed ' +
      '("Could not find public function for ..." means exactly this). ' +
      'Do NOT run `npx convex deploy` or `npx convex dev` in the shell: those need an ' +
      'interactive login, and this tool already holds the credential.',
    inputSchema: {
      type: 'object',
      properties: {
        projectDir: {
          type: 'string',
          description: 'Repo root holding the `convex/` directory. Defaults to the session cwd.',
        },
        previewName: {
          type: 'string',
          description:
            'Only for a PREVIEW deploy key: name the preview deployment to create (e.g. a branch name).',
        },
      },
      additionalProperties: false,
    },
  },
];

/** Injectable child-process runner, so the deploy path is unit-testable. */
export interface DeploySpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}
export interface DeployOpts {
  cwd?: string;
  timeoutMs?: number;
  spawnImpl?: (
    cmd: string,
    args: string[],
    opts: { cwd?: string; env: NodeJS.ProcessEnv },
  ) => Promise<DeploySpawnResult>;
}

/** Default runner: spawn, capture both streams, resolve with the exit code. */
function defaultSpawn(timeoutMs: number) {
  return (
    cmd: string,
    args: string[],
    opts: { cwd?: string; env: NodeJS.ProcessEnv },
  ): Promise<DeploySpawnResult> =>
    new Promise((resolve) => {
      let out = '';
      let err = '';
      let done = false;
      const finish = (code: number): void => {
        if (done) return;
        done = true;
        resolve({ code, stdout: out, stderr: err });
      };
      let child;
      try {
        child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        finish(1);
        err = e instanceof Error ? e.message : String(e);
        return;
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        err += `\n[codeam] convex deploy timed out after ${Math.round(timeoutMs / 1000)}s`;
        finish(124);
      }, timeoutMs);
      child.stdout?.on('data', (c: Buffer) => {
        out += c.toString();
      });
      child.stderr?.on('data', (c: Buffer) => {
        err += c.toString();
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        err += (err ? '\n' : '') + e.message;
        finish(1);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        finish(code ?? 1);
      });
    });
}

/**
 * Resolve the Convex CLI. Prefer the project's OWN binary — `npx` on a cold
 * cache would fetch a version the repo never pinned, and npm 11's `npx` can
 * fork-exec and exit 0 while the child is orphaned (the same trap the preview
 * spawner documents). `npx --yes` is the fallback for a repo that has convex as
 * a transitive/absent dep.
 */
export function resolveConvexBin(cwd: string): { cmd: string; args: string[] } {
  const local = path.join(cwd, 'node_modules', '.bin', process.platform === 'win32' ? 'convex.cmd' : 'convex');
  if (fs.existsSync(local)) return { cmd: local, args: [] };
  return { cmd: 'npx', args: ['--yes', 'convex'] };
}

/** Redact the deploy key anywhere it appears in text we hand back to the agent. */
function redact(text: string, key: string): string {
  if (!key) return text;
  return text.split(key).join('***');
}

/**
 * Deploy the repo's Convex functions using Convex's OWN CLI, with the brokered
 * deploy key injected into THAT CHILD's environment only.
 *
 * ⚠️ Why a child process and not the admin REST API the other tools use: a
 * Convex deploy is typecheck + codegen + BUNDLE + push, not a request.
 * Reimplementing Convex's bundler would be large and would drift with every
 * Convex release; driving their CLI is the documented headless path
 * (`CONVEX_DEPLOY_KEY` + `npx convex deploy`), and the key itself encodes the
 * target deployment, so we choose nothing on the user's behalf.
 *
 * ⚠️ The credential goes in `env`, NEVER in argv — argv is world-readable via
 * `ps`. It is also redacted out of whatever the CLI prints back.
 */
export async function runConvexDeploy(
  key: string,
  args: { projectDir?: string; previewName?: string },
  opts: DeployOpts = {},
): Promise<{ ok: boolean; text: string }> {
  const cwd = args.projectDir ?? opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const run = opts.spawnImpl ?? defaultSpawn(timeoutMs);
  const bin = resolveConvexBin(cwd);
  const argv = [...bin.args, 'deploy'];
  if (args.previewName) argv.push('--preview-create', String(args.previewName));

  const { code, stdout, stderr } = await run(bin.cmd, argv, {
    cwd,
    // The ONLY place the secret travels.
    env: { ...process.env, CONVEX_DEPLOY_KEY: key },
  });
  const body = redact([stdout, stderr].filter(Boolean).join('\n').trim(), key);
  if (code === 0) {
    return { ok: true, text: body || 'Convex deploy completed.' };
  }
  return {
    ok: false,
    text: `Convex deploy failed (exit ${code}).\n${body}`,
  };
}

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
  deployOpts: DeployOpts = {},
): Promise<{ ok: boolean; text: string }> {
  switch (tool) {
    case 'deploy':
      return runConvexDeploy(
        key,
        {
          projectDir: typeof args.projectDir === 'string' ? args.projectDir : undefined,
          previewName: typeof args.previewName === 'string' ? args.previewName : undefined,
        },
        deployOpts,
      );
  }
  // Every remaining tool is served by the deployment's admin REST API, which
  // needs a deployment host. A `project:` deploy key encodes a project, not a
  // deployment, so there is nothing to call — say so instead of firing a
  // request at an empty origin (which reads as a network error).
  if (!baseUrl) {
    return {
      ok: false,
      text:
        `The connected Convex deploy key is a PROJECT key, which names no single deployment, ` +
        `so '${tool}' (and the other data tools) cannot reach one. Use the 'deploy' tool — it ` +
        `resolves the target from the key itself — or reconnect Convex with a dev/prod deploy ` +
        `key (Convex Dashboard → Project Settings → Deploy Keys) to enable the data tools.`,
    };
  }
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
  // ⚠️ A key we cannot derive a deployment from is NOT fatal any more. A
  // `project:` deploy key is valid (the backend validator accepts it) and
  // deploys fine — the Convex CLI resolves the target from the key itself — it
  // just names no single deployment for the admin REST API. Exiting here left
  // that user with NO Convex tools at all, including the one that would have
  // worked. Serve the server with an empty baseUrl instead: `deploy` works and
  // the data tools answer with an actionable reason (see `callConvexTool`).
  if (!name) {
    process.stderr.write(
      `[codeam mcp-run convex] the deploy key names no single deployment ` +
        `(prefix "${key.split(':')[0]}"): the data tools are unavailable, 'deploy' still works. ` +
        `For the data tools, reconnect with a dev/prod deploy key ` +
        `(Convex Dashboard → Project Settings → Deploy Keys).\n`,
    );
  }
  const baseUrl = name ? `https://${name}.convex.cloud` : '';

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
