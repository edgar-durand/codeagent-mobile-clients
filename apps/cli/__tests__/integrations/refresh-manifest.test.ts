import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IntegrationsManifest } from '@codeam/shared';

/**
 * Real HTTP server, real file on a real (temp) HOME — because the failure this
 * guards against was invisible to anything mocked: every layer "worked" and the
 * box still launched a package that had been swapped out hours earlier.
 *
 * The manifest on disk is written once and then preferred over the CLI's
 * bundled registry BY DESIGN. Nothing regenerated it when the registry changed,
 * so the 2026-09-03 ClickUp switch (off a paywalled server) reached neither the
 * user who reported it nor anyone else until they next touched an integration.
 * `refreshIntegrationsManifest` asks the backend at start and rewrites the file
 * when it differs. These cases pin the three behaviours that matter: rewrite
 * when stale, leave alone when equal, and fall back to disk when the backend
 * cannot answer (an older backend without the endpoint answers 404).
 */

const OLD: IntegrationsManifest = {
  integrations: [
    {
      id: 'clickup',
      delivery: {
        mcp: {
          command: 'npx',
          args: ['-y', '@taazkareem/clickup-mcp-server@0.14.4'],
          envMapping: { CLICKUP_API_KEY: 'accessToken', CLICKUP_TEAM_ID: 'teamId' },
        },
      },
    } as IntegrationsManifest['integrations'][number],
  ],
};
const NEW: IntegrationsManifest = {
  integrations: [
    {
      id: 'clickup',
      delivery: {
        mcp: {
          command: 'npx',
          args: ['-y', 'clickup-mcp-pro@1.0.1'],
          envMapping: { CLICKUP_API_TOKEN: 'accessToken', CLICKUP_TEAM_ID: 'teamId' },
        },
      },
    } as IntegrationsManifest['integrations'][number],
  ],
};

let home: string;
let server: Server | null = null;
let seenAuth: string | undefined;
const origHome = process.env.HOME;
const origApi = process.env.CODEAM_API_URL;

function manifestFile(): string {
  return join(home, '.codeam', 'integrations.json');
}
function writeOnDisk(m: IntegrationsManifest): void {
  mkdirSync(join(home, '.codeam'), { recursive: true });
  writeFileSync(manifestFile(), JSON.stringify(m));
}
function onDisk(): IntegrationsManifest | null {
  return existsSync(manifestFile()) ? (JSON.parse(readFileSync(manifestFile(), 'utf8')) as IntegrationsManifest) : null;
}

/** A real backend stand-in: answers POST /api/plugin/integrations/manifest. */
async function serve(handler: (path: string) => { status: number; body?: unknown }): Promise<string> {
  server = createServer((req, res) => {
    seenAuth = req.headers['x-plugin-auth-token'] as string | undefined;
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const r = handler(req.url ?? '');
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(r.body === undefined ? '' : JSON.stringify(r.body));
    });
  });
  await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return `http://127.0.0.1:${addr.port}`;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'refresh-manifest-'));
  process.env.HOME = home;
  seenAuth = undefined;
});
afterEach(async () => {
  if (server) await new Promise<void>((ok) => server!.close(() => ok()));
  server = null;
  process.env.HOME = origHome;
  if (origApi === undefined) delete process.env.CODEAM_API_URL;
  else process.env.CODEAM_API_URL = origApi;
});

const CTX = { sessionId: 'sess-1', pluginId: 'plug-1', pluginAuthToken: 'v1.test-token' };

describe('refreshIntegrationsManifest — the on-disk manifest stops being trusted forever', () => {
  it('REWRITES a stale manifest with what the backend resolves now (the ClickUp case)', async () => {
    writeOnDisk(OLD);
    process.env.CODEAM_API_URL = await serve((p) =>
      p === '/api/plugin/integrations/manifest' ? { status: 200, body: { success: true, data: NEW } } : { status: 404 },
    );
    const { refreshIntegrationsManifest } = await import('../../src/integrations/refresh-manifest');

    const r = await refreshIntegrationsManifest(CTX);

    expect(r).toEqual({ status: 'rewritten', before: 1, after: 1 });
    // ⚠️ THE assertion: the file the shim will read now names the new package.
    expect(onDisk()!.integrations[0].delivery.mcp!.args).toContain('clickup-mcp-pro@1.0.1');
    expect(Object.keys(onDisk()!.integrations[0].delivery.mcp!.envMapping)).toContain('CLICKUP_API_TOKEN');
    // And it authenticated as the plugin, like every other plugin call.
    expect(seenAuth).toBe('v1.test-token');
  });

  it('leaves an up-to-date manifest untouched (no needless rewrite, key order ignored)', async () => {
    writeOnDisk(NEW);
    const before = readFileSync(manifestFile(), 'utf8');
    // Same content, different key order — must still count as equal.
    const reordered = JSON.parse(JSON.stringify(NEW)) as IntegrationsManifest;
    process.env.CODEAM_API_URL = await serve(() => ({ status: 200, body: { success: true, data: reordered } }));
    const { refreshIntegrationsManifest } = await import('../../src/integrations/refresh-manifest');

    expect(await refreshIntegrationsManifest(CTX)).toEqual({ status: 'unchanged' });
    expect(readFileSync(manifestFile(), 'utf8')).toBe(before);
  });

  it('falls back to the file on disk when the backend predates the endpoint (404) or is down', async () => {
    writeOnDisk(OLD);
    process.env.CODEAM_API_URL = await serve(() => ({ status: 404 }));
    const { refreshIntegrationsManifest } = await import('../../src/integrations/refresh-manifest');

    expect(await refreshIntegrationsManifest(CTX)).toEqual({ status: 'skipped', reason: 'HTTP 404' });
    // The stale file is still there — a stale manifest beats no session.
    expect(onDisk()!.integrations[0].delivery.mcp!.args).toContain('@taazkareem/clickup-mcp-server@0.14.4');

    // Backend unreachable: same outcome, and it must not throw.
    await new Promise<void>((ok) => server!.close(() => ok()));
    server = null;
    const r = await refreshIntegrationsManifest(CTX, fetch, 2_000);
    expect(r.status).toBe('skipped');
  });
});
