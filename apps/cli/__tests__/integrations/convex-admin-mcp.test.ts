import { describe, it, expect, vi } from 'vitest';
import { deploymentNameFromKey, callConvexTool } from '../../src/integrations/convex-admin-mcp';

describe('deploymentNameFromKey', () => {
  it('derives the deployment name from a dev deploy key', () => {
    expect(deploymentNameFromKey('dev:famous-skunk-76|abc123')).toBe('famous-skunk-76');
  });
  it('derives from a prod deploy key', () => {
    expect(deploymentNameFromKey('prod:happy-animal-1|xyz')).toBe('happy-animal-1');
  });
  it('handles a preview deploy key (name is the 2nd segment)', () => {
    expect(deploymentNameFromKey('preview:cool-otter-9|abc')).toBe('cool-otter-9');
  });
  it('returns null for a project key (no single deployment)', () => {
    expect(deploymentNameFromKey('project:team:proj|abc')).toBeNull();
  });
  it('returns null for a team/OAuth token', () => {
    expect(deploymentNameFromKey('team:acme|abc')).toBeNull();
  });
});

describe('callConvexTool', () => {
  const KEY = 'dev:famous-skunk-76|secret';
  const URL = 'https://famous-skunk-76.convex.cloud';

  function fakeFetch(status: number, body: string) {
    return vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;
  }

  it('tables → POSTs getTableMapping to /api/query with Convex admin auth', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{"status":"success","value":{"1":"messages"}}', { status: 200 });
    }) as unknown as typeof fetch;
    const r = await callConvexTool(URL, KEY, 'tables', {}, f);
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe(`${URL}/api/query`);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Convex ${KEY}`);
    expect(JSON.parse(calls[0].init.body as string).path).toBe('_system/frontend/getTableMapping');
  });

  it('data → queryTable with the table name', async () => {
    let sentBody = '';
    const f = (async (_url: string, init: RequestInit) => {
      sentBody = init.body as string;
      return new Response('{"status":"success","value":[]}', { status: 200 });
    }) as unknown as typeof fetch;
    await callConvexTool(URL, KEY, 'data', { table: 'messages', limit: 10 }, f);
    const body = JSON.parse(sentBody);
    expect(body.path).toBe('_system/cli/queryTable');
    expect(body.args.tableName).toBe('messages');
    expect(body.args.limit).toBe(10);
  });

  it('run_mutation → hits /api/mutation with the function path', async () => {
    let url = '';
    const f = (async (u: string) => {
      url = u;
      return new Response('{"status":"success","value":null}', { status: 200 });
    }) as unknown as typeof fetch;
    await callConvexTool(URL, KEY, 'run_mutation', { functionPath: 'messages:send', args: { t: 'hi' } }, f);
    expect(url).toBe(`${URL}/api/mutation`);
  });

  it('flags a UDF-level error (HTTP 200 + status:error) as not ok', async () => {
    const r = await callConvexTool(URL, KEY, 'schema', {}, fakeFetch(200, '{"status":"error","errorMessage":"boom"}'));
    expect(r.ok).toBe(false);
  });

  it('flags an HTTP 4xx as not ok', async () => {
    const r = await callConvexTool(URL, KEY, 'tables', {}, fakeFetch(401, 'nope'));
    expect(r.ok).toBe(false);
  });
});

/**
 * `deploy` — the tool that closes the gap that cost a real user $7.59.
 *
 * The user pastes a Convex DEPLOY KEY to connect the integration, so we hold
 * the exact credential `npx convex deploy` reads from `CONVEX_DEPLOY_KEY`. But
 * it lived only inside this MCP, and the agent's SHELL never saw it — so the
 * agent looped on `npx convex dev`, which demands an interactive login, and at
 * one point asked the user to paste the token into the chat. He ended up
 * pasting the SAME key he had already given us into Environment Variables by
 * hand (rafaelph90.br@gmail.com, 2026-09-15).
 *
 * Deploying is bundling + push, not a REST call, so this tool drives Convex's
 * OWN CLI — with the key injected into THAT CHILD's env only. The secret never
 * enters the agent's shell, never appears in argv (`ps`), and never comes back
 * in the tool output.
 */
describe('runConvexDeploy', () => {
  const KEY = 'prod:happy-animal-1|supersecret';

  function fakeSpawn(result: { code: number; stdout: string; stderr: string }) {
    return vi.fn(async () => result);
  }

  it('runs the Convex CLI with the deploy key in the CHILD env, never in argv', async () => {
    const spawn = fakeSpawn({ code: 0, stdout: 'Deployed Convex functions', stderr: '' });
    const { runConvexDeploy } = await import('../../src/integrations/convex-admin-mcp');
    const res = await runConvexDeploy(KEY, {}, { cwd: '/repo', spawnImpl: spawn });

    expect(res.ok).toBe(true);
    const [, args, opts] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv; cwd?: string },
    ];
    expect(args).toContain('deploy');
    // The credential travels ONLY in the env — argv is world-readable via `ps`.
    expect(args.join(' ')).not.toContain('supersecret');
    expect(opts.env.CONVEX_DEPLOY_KEY).toBe(KEY);
    expect(opts.cwd).toBe('/repo');
  });

  it('never echoes the key back in the tool output, even on failure', async () => {
    const spawn = fakeSpawn({
      code: 1,
      stdout: '',
      // Convex itself can print the key back at us; we must not relay it.
      stderr: `auth failed for CONVEX_DEPLOY_KEY=${KEY}`,
    });
    const { runConvexDeploy } = await import('../../src/integrations/convex-admin-mcp');
    const res = await runConvexDeploy(KEY, {}, { cwd: '/repo', spawnImpl: spawn });

    expect(res.ok).toBe(false);
    expect(res.text).not.toContain('supersecret');
    expect(res.text).toContain('CONVEX_DEPLOY_KEY=***');
  });

  it('a non-zero exit is a failed tool call, with Convex own output surfaced', async () => {
    const spawn = fakeSpawn({ code: 1, stdout: 'typecheck failed', stderr: 'error in convex/x.ts' });
    const { runConvexDeploy } = await import('../../src/integrations/convex-admin-mcp');
    const res = await runConvexDeploy(KEY, {}, { cwd: '/repo', spawnImpl: spawn });

    expect(res.ok).toBe(false);
    expect(res.text).toContain('typecheck failed');
    expect(res.text).toContain('error in convex/x.ts');
  });

  it('passes --preview-create only when a preview name is asked for', async () => {
    const plain = fakeSpawn({ code: 0, stdout: 'ok', stderr: '' });
    const { runConvexDeploy } = await import('../../src/integrations/convex-admin-mcp');
    await runConvexDeploy(KEY, {}, { cwd: '/repo', spawnImpl: plain });
    expect((plain.mock.calls[0] as unknown as [string, string[]])[1]).not.toContain(
      '--preview-create',
    );

    const preview = fakeSpawn({ code: 0, stdout: 'ok', stderr: '' });
    await runConvexDeploy(KEY, { previewName: 'my-branch' }, { cwd: '/repo', spawnImpl: preview });
    const args = (preview.mock.calls[0] as unknown as [string, string[]])[1];
    expect(args).toContain('--preview-create');
    expect(args).toContain('my-branch');
  });

  it('is reachable as a tool through callConvexTool', async () => {
    const spawn = fakeSpawn({ code: 0, stdout: 'Deployed', stderr: '' });
    const { callConvexTool } = await import('../../src/integrations/convex-admin-mcp');
    const res = await callConvexTool(
      'https://happy-animal-1.convex.cloud',
      KEY,
      'deploy',
      {},
      undefined,
      { cwd: '/repo', spawnImpl: spawn },
    );
    expect(res.ok).toBe(true);
    expect(res.text).toContain('Deployed');
    expect(spawn).toHaveBeenCalled();
  });
});

/**
 * A `project:` deploy key is accepted by the backend validator ("project keys
 * have no single deployment, so they pass on format alone") but no deployment
 * name can be derived from it — so the admin REST base URL cannot be built.
 *
 * The server used to `process.exit(1)` in that case, leaving the user with NO
 * Convex tools at all. But a project key deploys perfectly well: `deploy`
 * drives Convex's CLI, which resolves the target from the key itself. So the
 * REST-backed tools degrade with an actionable message and `deploy` stays live.
 */
describe('a project: key keeps deploy available', () => {
  const PROJECT_KEY = 'project:acme:my-app|secret';

  it('derives no deployment name (unchanged)', async () => {
    const { deploymentNameFromKey } = await import('../../src/integrations/convex-admin-mcp');
    expect(deploymentNameFromKey(PROJECT_KEY)).toBeNull();
  });

  it('deploy works with no base URL', async () => {
    const spawn = vi.fn(async () => ({ code: 0, stdout: 'Deployed', stderr: '' }));
    const { callConvexTool } = await import('../../src/integrations/convex-admin-mcp');
    const res = await callConvexTool('', PROJECT_KEY, 'deploy', {}, undefined, {
      cwd: '/repo',
      spawnImpl: spawn,
    });
    expect(res.ok).toBe(true);
    expect(spawn).toHaveBeenCalled();
  });

  it('a REST-backed tool says WHY instead of firing a request at an empty host', async () => {
    const fetchSpy = vi.fn();
    const { callConvexTool } = await import('../../src/integrations/convex-admin-mcp');
    const res = await callConvexTool('', PROJECT_KEY, 'tables', {}, fetchSpy as unknown as typeof fetch);
    expect(res.ok).toBe(false);
    expect(res.text).toMatch(/deploy key/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.text).not.toContain('secret');
  });
});
