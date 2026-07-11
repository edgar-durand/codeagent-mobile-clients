import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same home-dir seam as integrations-manifest.test.ts so resolveDelivery's
// manifest read is exercised against a throwaway ~/.codeam.
const { FAKE_HOME } = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os');
  const fs = require('node:fs') as typeof import('node:fs');
  const p = require('node:path') as typeof import('node:path');
  return { FAKE_HOME: fs.mkdtempSync(p.join(os.tmpdir(), 'mcp-run-home-')) };
});
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>();
  return { ...actual, homedir: () => FAKE_HOME, default: { ...actual, homedir: () => FAKE_HOME } };
});

import { resolveDelivery } from '../src/integrations/mcp-run';
import { persistIntegrationsManifest, clearIntegrationsManifest } from '../src/integrations/manifest';
import { INTEGRATION_REGISTRY } from '@codeam/shared';

describe('mcp-run resolveDelivery — staticEnv rollout defense', () => {
  beforeEach(() => {
    clearIntegrationsManifest();
  });

  it('merges the bundled registry staticEnv under a manifest that lacks it (pre-staticEnv backend)', () => {
    // Mimic a backend pinned to a pre-staticEnv @codeam/shared: the manifest's
    // delivery has command/args/envMapping but NO staticEnv.
    persistIntegrationsManifest({
      integrations: [
        {
          id: 'jira',
          delivery: {
            mcp: {
              command: 'uvx',
              args: ['mcp-atlassian==0.22.1'],
              envMapping: { ATLASSIAN_OAUTH_ACCESS_TOKEN: 'accessToken' },
            },
          },
        },
      ],
    });

    const resolved = resolveDelivery('jira');
    expect(resolved).not.toBeNull();
    // Manifest fields preserved…
    expect(resolved!.command).toBe('uvx');
    expect(resolved!.envMapping).toEqual({ ATLASSIAN_OAUTH_ACCESS_TOKEN: 'accessToken' });
    // …and the registry's boot flag backfilled underneath.
    expect(resolved!.staticEnv?.ATLASSIAN_OAUTH_ENABLE).toBe('true');
  });

  it('manifest staticEnv values win over the registry on collision', () => {
    persistIntegrationsManifest({
      integrations: [
        {
          id: 'jira',
          delivery: {
            mcp: {
              command: 'uvx',
              args: ['mcp-atlassian==0.22.1'],
              envMapping: { ATLASSIAN_OAUTH_ACCESS_TOKEN: 'accessToken' },
              staticEnv: { ATLASSIAN_OAUTH_ENABLE: 'false', EXTRA_FLAG: 'x' },
            },
          },
        },
      ],
    });

    const resolved = resolveDelivery('jira');
    expect(resolved!.staticEnv).toEqual({ ATLASSIAN_OAUTH_ENABLE: 'false', EXTRA_FLAG: 'x' });
  });

  it('unknown manifest ids pass through untouched (no registry staticEnv to merge)', () => {
    persistIntegrationsManifest({
      integrations: [
        {
          // Forward-compat: a future backend may ship ids this CLI's bundled
          // registry doesn't know. The manifest spec must be used verbatim.
          id: 'linear' as never,
          delivery: {
            mcp: { command: 'npx', args: ['linear-mcp'], envMapping: { LINEAR_TOKEN: 'accessToken' } },
          },
        },
      ],
    });

    const resolved = resolveDelivery('linear');
    expect(resolved).not.toBeNull();
    expect(resolved!.command).toBe('npx');
    expect(resolved!.staticEnv).toBeUndefined();
  });

  it('falls back to the bundled registry (with its staticEnv) when no manifest exists', () => {
    const resolved = resolveDelivery('jira');
    expect(resolved).toEqual(INTEGRATION_REGISTRY.jira.delivery.mcp);
    expect(resolved!.staticEnv?.ATLASSIAN_OAUTH_ENABLE).toBe('true');
  });

  it('returns null for an unknown id with no manifest', () => {
    expect(resolveDelivery('nope')).toBeNull();
  });
});
