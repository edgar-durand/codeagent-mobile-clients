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
        // Version PINNED to the exact release verified headless by Plan 2's
        // Docker integration test (apps/cli mcp-shim.int.test.ts).
        command: 'uvx',
        args: ['mcp-atlassian==0.22.1'],
        envMapping: {
          ATLASSIAN_OAUTH_ACCESS_TOKEN: 'accessToken',
          ATLASSIAN_OAUTH_CLOUD_ID: 'cloudId',
        },
        // Without ATLASSIAN_OAUTH_ENABLE=true, JiraConfig.from_env() raises
        // "Missing required JIRA_URL" (swallowed at server startup) and the
        // server silently registers ZERO Jira tools. The flag activates
        // mcp-atlassian's "minimal OAuth config for user-provided tokens"
        // mode — the BYO-token path the broker feeds. Static + non-secret.
        staticEnv: { ATLASSIAN_OAUTH_ENABLE: 'true' },
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
