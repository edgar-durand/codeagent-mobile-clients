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

import {
  resolveDelivery,
  resolveLauncherPath,
  localBinCandidates,
} from '../src/integrations/mcp-run';
import {
  persistIntegrationsManifest,
  clearIntegrationsManifest,
} from '../src/integrations/manifest';
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
            mcp: {
              command: 'npx',
              args: ['linear-mcp'],
              envMapping: { LINEAR_TOKEN: 'accessToken' },
            },
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

describe('resolveLauncherPath — per-user bin fallback (fleet-1 uvx incident)', () => {
  const p = require('node:path') as typeof import('node:path');

  it('returns the bare command when it is on PATH', () => {
    const out = resolveLauncherPath('uvx', {
      commandExists: () => true,
      existsSync: () => false,
    });
    expect(out).toBe('uvx');
  });

  it('falls back to ~/.local/bin when the command is NOT on PATH', () => {
    const expected = p.join(FAKE_HOME, '.local', 'bin', 'uvx');
    const out = resolveLauncherPath('uvx', {
      commandExists: () => false,
      existsSync: (candidate: string) => candidate === expected,
    });
    expect(out).toBe(expected);
  });

  it('falls back to ~/.cargo/bin when ~/.local/bin misses too', () => {
    const expected = p.join(FAKE_HOME, '.cargo', 'bin', 'uvx');
    const out = resolveLauncherPath('uvx', {
      commandExists: () => false,
      existsSync: (candidate: string) => candidate === expected,
    });
    expect(out).toBe(expected);
  });

  it('returns the bare command when nothing resolves (spawn surfaces the ENOENT)', () => {
    const out = resolveLauncherPath('uvx', {
      commandExists: () => false,
      existsSync: () => false,
    });
    expect(out).toBe('uvx');
  });

  it('probes the documented per-user install dirs in order', () => {
    expect(localBinCandidates('uvx')).toEqual([
      p.join(FAKE_HOME, '.local', 'bin', 'uvx'),
      p.join(FAKE_HOME, '.cargo', 'bin', 'uvx'),
    ]);
  });
});

describe('mcp-run childEnvFor — the launcher defaults ride under every server', () => {
  it('disables npm audit/fund/notifier, keeps staticEnv, and lets the credential mapping win', async () => {
    // 2026-09-03: a cold `npx -y clickup-mcp-pro@1.0.1` spent 268 s in
    // `npm audit` (`/-/npm/v1/security/advisories/bulk`) while the install
    // itself took 3 s — the server printed nothing and the agent filed it as
    // "not connected". The audit is switched off through npm's env config.
    const { childEnvFor } = await import('../src/integrations/mcp-run');
    const { LAUNCHER_ENV } = await import('../src/integrations/launcher-env');
    const delivery = {
      command: 'npx',
      args: ['-y', 'some-mcp@1.0.0'],
      envMapping: { SOME_TOKEN: 'accessToken', SOME_TEAM: 'teamId' },
      staticEnv: { SOME_MODE: 'stdio', npm_config_fund: 'true' },
    } as unknown as import('@codeam/shared').IntegrationMcpDelivery;
    const token = {
      accessToken: 'tok-1',
      teamId: 'team-9',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } as unknown as import('@codeam/shared').BrokeredIntegrationToken;

    const env = childEnvFor(delivery, token);

    expect(env.npm_config_audit).toBe('false');
    expect(env.npm_config_update_notifier).toBe('false');
    expect(LAUNCHER_ENV.npm_config_audit).toBe('false');
    // Registry staticEnv sits ABOVE the launcher defaults (a registry entry may
    // deliberately override one), and the credential mapping above both.
    expect(env.npm_config_fund).toBe('true');
    expect(env.SOME_MODE).toBe('stdio');
    expect(env.SOME_TOKEN).toBe('tok-1');
    expect(env.SOME_TEAM).toBe('team-9');
  });
});
