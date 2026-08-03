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
