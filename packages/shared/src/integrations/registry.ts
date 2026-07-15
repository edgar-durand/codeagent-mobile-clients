import type { IntegrationDefinition, IntegrationId } from './types';

/**
 * The single source of truth for supported integrations. Adding one =
 * 1 entry here + 1 backend OAuth provider + icon. The `delivery` spec is
 * resolved into deploy manifests and executed as data by the CLI, so a new
 * MCP integration with no special logic needs no CLI release.
 */
export const INTEGRATION_REGISTRY: Record<IntegrationId, IntegrationDefinition> = {
  jira: {
    // Registry id kept 'jira' for id-stability (existing LinkedIntegration rows
    // stay valid — zero data migration); only the DISPLAY is "Atlassian". The
    // one mcp-atlassian server serves BOTH Jira and Confluence, so the same
    // entry now requests Confluence scopes too.
    id: 'jira',
    name: 'Atlassian',
    icon: 'jira',
    enabled: true,
    auth: {
      kind: 'oauth_redirect',
      // Jira + Confluence 3LO granular scopes. The Confluence pair
      // (read:confluence-content.all / write:confluence-content) is the set
      // mcp-atlassian's own Authentication docs recommend for full read+write
      // Confluence (matches its documented env scope string).
      scopes: [
        'read:jira-work',
        'write:jira-work',
        'read:confluence-content.all',
        'write:confluence-content',
        'offline_access',
      ],
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
  sentry: {
    id: 'sentry',
    name: 'Sentry',
    icon: 'sentry',
    // LIVE — the Sentry OAuth Application (Confidential) is registered and
    // SENTRY_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI are in Secret Manager
    // (prod+dev). The backend SentryOAuthProvider is config-gated (503 if
    // env unset) so this is safe even mid-rollout before the secrets mount.
    enabled: true,
    auth: {
      kind: 'oauth_redirect',
      // FULL read+write across every Sentry resource — the agent can read
      // issues/events/projects AND act (resolve/assign issues, manage
      // projects/teams/members, releases). `:write` implies `:read`. Admin
      // (destructive org/member management) is deliberately NOT requested.
      // ⚠️ Changing these requires the user to RE-LINK Sentry — the existing
      // token only carries whatever scopes it was granted at link time.
      scopes: [
        'org:read',
        'org:write',
        'project:read',
        'project:write',
        'team:read',
        'team:write',
        'member:read',
        'member:write',
        'event:read',
        'event:write',
        'project:releases',
      ],
    },
    delivery: {
      mcp: {
        // Sentry's official stdio MCP server (Node). BYO-token headless: the
        // OAuth access token is fed via SENTRY_ACCESS_TOKEN and the host via
        // SENTRY_HOST (never argv — env only). Version PINNED; bump only
        // after re-verifying headless in the mcp-shim integration test.
        command: 'npx',
        // `--add-scopes` widens the server's default READ-ONLY tool surface to
        // include the write tools our OAuth scopes now grant (resolve/assign
        // issue, update project, etc.), so the agent exposes read AND write.
        args: [
          '-y',
          '@sentry/mcp-server@0.18.0',
          '--add-scopes=org:write,project:write,team:write,member:write,event:write',
        ],
        envMapping: {
          SENTRY_ACCESS_TOKEN: 'accessToken',
          SENTRY_HOST: 'host',
        },
      },
    },
  },
  linear: {
    id: 'linear',
    name: 'Linear',
    icon: 'linear',
    // LIVE — the Linear OAuth Application (Public + Confidential) is registered
    // and LINEAR_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI are in Secret Manager
    // (prod+dev). The backend LinearOAuthProvider is config-gated (503 if env
    // unset) so this is safe even mid-rollout before the secrets mount.
    enabled: true,
    auth: {
      kind: 'oauth_redirect',
      // Linear's coarse scopes: `read` (all issues/projects/comments/cycles)
      // + `write` (create/update issues, comments, state). `write` implies the
      // create/update surface the agent's tools need. `admin` (destructive
      // workspace management) is deliberately NOT requested. ⚠️ Changing these
      // requires the user to RE-LINK Linear — the token only carries the scopes
      // granted at link time. Linear expects a COMMA-separated `scope` param.
      scopes: ['read', 'write'],
    },
    delivery: {
      mcp: {
        // mcp-linear (stdio, @linear/sdk) in BYO-token headless mode: the OAuth
        // access token is fed via LINEAR_API_KEY (env only, never argv) and the
        // Linear GraphQL API accepts it as the Authorization header directly.
        // Verified headless end-to-end (search_issues returned real issues) —
        // the OFFICIAL remote MCP (mcp.linear.app) can't be used here because it
        // forces its own interactive browser OAuth. Version PINNED; bump only
        // after re-verifying headless. Tools: search/get/create/update issue +
        // add comment (read + write).
        command: 'npx',
        args: ['-y', 'mcp-linear@0.1.8'],
        envMapping: {
          LINEAR_API_KEY: 'accessToken',
        },
      },
    },
  },
  slack: {
    id: 'slack',
    name: 'Slack',
    icon: 'slack',
    // LIVE — the Slack app (OAuth v2, bot token) is registered and
    // SLACK_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI are in Secret Manager
    // (prod+dev). The backend SlackOAuthProvider is config-gated (503 if env
    // unset) so this is safe even mid-rollout before the secrets mount.
    enabled: true,
    auth: {
      kind: 'oauth_redirect',
      // Slack Bot Token Scopes (OAuth v2). Read + write across channels,
      // groups, DMs: list/read history, post messages, react. `scope` is
      // COMMA-separated in the authorize URL. ⚠️ Changing these requires the
      // user to RE-INSTALL the Slack app — the bot token only carries the
      // scopes granted at install time. The bot can only read channels it's
      // been invited to (standard Slack bot behavior).
      scopes: [
        'channels:read',
        'channels:history',
        'groups:read',
        'groups:history',
        'chat:write',
        'reactions:read',
        'reactions:write',
        'users:read',
        'im:read',
        'im:history',
        'mpim:read',
        'mpim:history',
      ],
    },
    delivery: {
      mcp: {
        // Slack's official reference MCP server (Node). BYO-token headless: the
        // OAuth v2 bot token (xoxb-…) is fed via SLACK_BOT_TOKEN and the team
        // id via SLACK_TEAM_ID (env only, never argv). The server sends the
        // token as `Authorization: Bearer`. Version PINNED; bump only after
        // re-verifying headless. Tools: list_channels, post_message,
        // reply_to_thread, add_reaction, get_channel_history,
        // get_thread_replies, get_users, get_user_profile (read + write).
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-slack@2025.4.25'],
        envMapping: {
          SLACK_BOT_TOKEN: 'accessToken',
          SLACK_TEAM_ID: 'teamId',
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
