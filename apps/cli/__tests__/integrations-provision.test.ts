import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Same FAKE_HOME seam as __tests__/integrations-manifest.test.ts — os.homedir()
// on macOS can ignore $HOME, so mocking node:os is the reliable way to point
// the manifest reader at a throwaway ~/.codeam without touching the real one.
const { FAKE_HOME } = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os');
  const fs = require('node:fs') as typeof import('node:fs');
  const p = require('node:path') as typeof import('node:path');
  return { FAKE_HOME: fs.mkdtempSync(p.join(os.tmpdir(), 'integrations-provision-home-')) };
});
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>();
  return { ...actual, homedir: () => FAKE_HOME, default: { ...actual, homedir: () => FAKE_HOME } };
});

import { buildMcpServersForStart } from '../src/integrations/provision';
import { integrationsManifestPath, clearIntegrationsManifest } from '../src/integrations/manifest';
import type { IntegrationsManifest } from '@codeam/shared';
import type { McpServerStdio } from '@agentclientprotocol/sdk';

const JIRA_MANIFEST: IntegrationsManifest = {
  integrations: [
    {
      id: 'jira',
      delivery: {
        mcp: {
          command: 'codeam',
          args: ['mcp-run', 'jira'],
          envMapping: { JIRA_ACCESS_TOKEN: 'accessToken' },
        },
      },
    },
  ],
};

function writeManifest(m: IntegrationsManifest): void {
  const file = integrationsManifestPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(m), 'utf8');
}

describe('buildMcpServersForStart', () => {
  beforeEach(() => {
    clearIntegrationsManifest();
  });

  it('with a jira manifest + full ctx, builds one McpServerStdio pointing at the shim', () => {
    writeManifest(JIRA_MANIFEST);

    const servers = buildMcpServersForStart({
      sessionId: 'sess-1',
      pluginId: 'plugin-1',
      pluginAuthToken: 'plugin-token-abc',
      pollSecret: 'poll-secret-xyz',
    });

    expect(servers).toHaveLength(1);
    const server = servers[0] as McpServerStdio;
    expect(server.name).toBe('jira');
    expect(server.command).toBe(process.execPath);
    expect(server.args).toEqual([process.argv[1], 'mcp-run', 'jira']);

    const envMap = Object.fromEntries(server.env.map((e) => [e.name, e.value]));
    expect(envMap.CODEAM_MCP_INTEGRATION_ID).toBe('jira');
    expect(envMap.CODEAM_MCP_SESSION_ID).toBe('sess-1');
    expect(envMap.CODEAM_MCP_PLUGIN_ID).toBe('plugin-1');
    expect(envMap.CODEAM_MCP_PLUGIN_TOKEN).toBe('plugin-token-abc');
    expect(envMap.CODEAM_MCP_POLL_SECRET).toBe('poll-secret-xyz');
  });

  it('omits CODEAM_MCP_POLL_SECRET when pollSecret is not provided', () => {
    writeManifest(JIRA_MANIFEST);

    const servers = buildMcpServersForStart({
      sessionId: 'sess-1',
      pluginId: 'plugin-1',
      pluginAuthToken: 'plugin-token-abc',
    });

    const server = servers[0] as McpServerStdio;
    expect(server.env.some((e) => e.name === 'CODEAM_MCP_POLL_SECRET')).toBe(false);
  });

  it('returns [] when no manifest file exists', () => {
    const servers = buildMcpServersForStart({
      sessionId: 'sess-1',
      pluginId: 'plugin-1',
      pluginAuthToken: 'plugin-token-abc',
    });
    expect(servers).toEqual([]);
  });

  it('returns [] when the manifest is present but pluginAuthToken is missing', () => {
    writeManifest(JIRA_MANIFEST);

    const servers = buildMcpServersForStart({
      sessionId: 'sess-1',
      pluginId: 'plugin-1',
    });
    expect(servers).toEqual([]);
  });

  it('skips an entry whose delivery.mcp is absent', () => {
    writeManifest({
      integrations: [
        {
          id: 'jira',
          delivery: {}, // no mcp delivery — e.g. cliEnv-only integration
        },
      ],
    });

    const servers = buildMcpServersForStart({
      sessionId: 'sess-1',
      pluginId: 'plugin-1',
      pluginAuthToken: 'plugin-token-abc',
    });
    expect(servers).toEqual([]);
  });

  it('serialized specs contain no token-looking material in argv — only in env', () => {
    writeManifest(JIRA_MANIFEST);

    const servers = buildMcpServersForStart({
      sessionId: 'sess-1',
      pluginId: 'plugin-1',
      pluginAuthToken: 'super-secret-plugin-token',
      pollSecret: 'super-secret-poll-secret',
    });

    const server = servers[0] as McpServerStdio;
    const argvBlob = JSON.stringify([server.command, ...server.args]);
    expect(argvBlob).not.toContain('super-secret-plugin-token');
    expect(argvBlob).not.toContain('super-secret-poll-secret');

    // The token DOES appear, but only inside the env array's values.
    const envBlob = JSON.stringify(server.env);
    expect(envBlob).toContain('super-secret-plugin-token');
  });
});
