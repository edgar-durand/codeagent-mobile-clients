import type { IntegrationDefinition, IntegrationId } from './types';

/**
 * The single source of truth for supported integrations. Adding one =
 * 1 entry here + 1 backend OAuth provider + icon. The `delivery` spec is
 * resolved into deploy manifests and executed as data by the CLI, so a new
 * MCP integration with no special logic needs no CLI release.
 */
export const INTEGRATION_REGISTRY: Record<IntegrationId, IntegrationDefinition> = {
  jira: {
    id: 'jira',
    name: 'Jira',
    icon: 'jira',
    enabled: true,
    auth: {
      kind: 'oauth_redirect',
      scopes: ['read:jira-work', 'write:jira-work', 'offline_access'],
    },
    delivery: {
      mcp: {
        // mcp-atlassian in BYO-token mode (headless; credentials via env only).
        // Plan 2's Docker integration test validates this spec end-to-end and
        // pins the exact version before release.
        command: 'uvx',
        args: ['mcp-atlassian'],
        envMapping: {
          ATLASSIAN_OAUTH_ACCESS_TOKEN: 'accessToken',
          ATLASSIAN_OAUTH_CLOUD_ID: 'cloudId',
        },
      },
    },
  },
};

export function getEnabledIntegrations(): IntegrationDefinition[] {
  return Object.values(INTEGRATION_REGISTRY).filter((m) => m.enabled);
}

export function getIntegration(id: IntegrationId): IntegrationDefinition {
  const meta = INTEGRATION_REGISTRY[id];
  if (!meta) throw new Error(`Unknown integration id: ${id}`);
  return meta;
}

export function isKnownIntegrationId(id: string): id is IntegrationId {
  return id in INTEGRATION_REGISTRY;
}
