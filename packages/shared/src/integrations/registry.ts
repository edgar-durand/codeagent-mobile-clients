import type {
  IntegrationCategory,
  IntegrationDefinition,
  IntegrationId,
} from './types';

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
    category: 'tracker',
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
    category: 'observability',
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
    category: 'tracker',
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
  github: {
    id: 'github',
    name: 'GitHub',
    icon: 'github',
    category: 'version_control',
    // LIVE. GitHub is the product's code substrate (codespaces + the PR
    // Command Center), and it was historically the ONE connection outside this
    // registry: its credential lives in a `ProviderToken` row rather than the
    // integrations vault, so it was rendered by a hand-written special-case row
    // and could not legally appear in a deploy's `integrationIds` (the manifest
    // resolver rejects unknown ids — a recurring bug class).
    //
    // `kind: 'connection'` closes that gap without re-plumbing OAuth: the entry
    // makes GitHub a first-class, categorised catalog row whose credential the
    // backend resolves from the SAME `ProviderToken` it always used, while the
    // connect/disconnect flow stays owned by the codespaces rail (the clients
    // route those two actions there). ⚠️ It is a REAL connection with a REAL
    // disconnect — do NOT treat it like `github_issues`, which merely derives
    // from it and has no actions of its own.
    enabled: true,
    auth: { kind: 'connection', connection: 'github' },
    // No MCP: a deployed box already has an authenticated `gh` on PATH.
    delivery: {},
  },
  gitlab: {
    id: 'gitlab',
    name: 'GitLab',
    icon: 'gitlab',
    category: 'version_control',
    // LIVE — a user-owned gitlab.com application (Confidential) with BOTH env
    // callbacks registered, so dev/prod share the client and differ only in
    // GITLAB_OAUTH_REDIRECT_URI. The backend GitLabOAuthProvider is
    // config-gated (503 if env unset), so this is safe mid-rollout.
    //
    // ⚠️ Unlike `github`, this is a NORMAL `oauth_redirect` integration: its
    // credential is vaulted here rather than living in a ProviderToken, because
    // nothing else in the product owns a GitLab connection (GitHub's lives on
    // the codespaces rail, which is why it's `kind: 'connection'`).
    enabled: true,
    auth: {
      kind: 'oauth_redirect',
      // GitLab has NO per-resource scopes — `api` is the only one that grants
      // merge-request WRITE (comment / approve / merge / close), so a
      // read-only alternative would make the whole MR surface useless.
      // `write_repository` is the git-over-HTTPS rail for the agent's push;
      // `api` already covers it for user tokens, but it costs nothing on a
      // consent screen that already says "complete read/write access" and
      // changing scopes later forces EVERY user to re-authorize.
      scopes: ['api', 'write_repository'],
    },
    // No MCP: the box's `git` is authenticated for push, and the MR surface is
    // served backend-side by the VCS provider — same shape as `github`.
    delivery: {},
  },
  github_issues: {
    id: 'github_issues',
    name: 'GitHub Issues',
    icon: 'github_issues',
    category: 'tracker',
    // LIVE, and the ONLY integration with NO link flow of its own: the
    // credential is DERIVED from the GitHub connection the user already made
    // for codespaces/PRs (`ProviderToken` provider='github-codespaces', which
    // carries `repo` scope — enough for the whole Issues surface). So there is
    // no OAuth app, no client id/secret, no Secret Manager entry and nothing
    // to configuration-gate. The backend auto-provisions the catalog row the
    // same way `ensureHouseAgentRow` does for the house agent, and resolves
    // the token live per call rather than vaulting a copy (it can't go stale,
    // and GitHub token refresh stays owned by exactly one place).
    enabled: true,
    auth: { kind: 'derived', derivedFrom: 'github' },
    // NO MCP server on purpose. Every other tracker needs one to give the agent
    // tools, but a deployed box ALREADY has an authenticated `gh` on PATH (the
    // codespace bootstrap exports GH_TOKEN), so `gh issue list/create/comment`
    // works with zero delivery. That also means nothing to pre-warm and no
    // third-party MCP package to pin and keep alive. The Start-from-Work-Item
    // side is served backend-side by the `TrackerProvider`, not by delivery.
    delivery: {},
  },
  slack: {
    id: 'slack',
    name: 'Slack',
    icon: 'slack',
    category: 'comms',
    // LIVE — the Slack app (OAuth v2, USER token — the agent acts AS THE USER)
    // is registered and
    // SLACK_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI are in Secret Manager
    // (prod+dev). The backend SlackOAuthProvider is config-gated (503 if env
    // unset) so this is safe even mid-rollout before the secrets mount.
    enabled: true,
    auth: {
      kind: 'oauth_redirect',
      // Slack USER Token Scopes (OAuth v2). Read + write across channels,
      // groups, DMs: list/read history, post messages, react — all AS THE USER.
      // The backend provider requests these under `user_scope` (comma-separated)
      // and stores the authed_user `xoxp-…` token, so the agent sees everything
      // the user sees (no bot needs to be invited to channels). ⚠️ Changing
      // these requires the user to RE-AUTHORIZE the Slack app.
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
        // Message search across the user's channels/DMs (a user-only scope).
        'search:read',
      ],
    },
    delivery: {
      mcp: {
        // Slack's official reference MCP server (Node). BYO-token headless: the
        // OAuth v2 USER token (xoxp-…) is fed via SLACK_BOT_TOKEN (the server's
        // env var name — it sends whatever token as `Authorization: Bearer`, and
        // Slack's Web API accepts a user token there) and the team id via
        // SLACK_TEAM_ID (env only, never argv). Version PINNED; bump only after
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
  microsoft_teams: {
    id: 'microsoft_teams',
    name: 'Microsoft Teams',
    icon: 'microsoft_teams',
    category: 'comms',
    // COMING SOON — placeholder catalog entry (no OAuth provider / MCP yet). The
    // agent will post review pings + read threads AS THE USER over Microsoft Graph
    // once the provider lands. `enabled:false` renders it as a dimmed "coming
    // soon" tile inside the (live) comms category.
    enabled: false,
    auth: { kind: 'oauth_redirect' },
    delivery: {},
  },
  google_chat: {
    id: 'google_chat',
    name: 'Google Chat',
    icon: 'google_chat',
    category: 'comms',
    // COMING SOON — placeholder catalog entry (no OAuth provider / MCP yet). The
    // agent will post review pings + read spaces AS THE USER over the Google Chat
    // API once the provider lands. `enabled:false` → dimmed "coming soon" tile.
    enabled: false,
    auth: { kind: 'oauth_redirect' },
    delivery: {},
  },
  discord: {
    id: 'discord',
    name: 'Discord',
    icon: 'discord',
    category: 'comms',
    // LIVE — the DiscordOAuthProvider + DISCORD_* secrets (client id/secret,
    // bot token, per-env redirect) are registered; the backend provider is
    // config-gated (503 if env unset). Follows the SLACK pattern (OAuth redirect, zero friction),
    // EXCEPT Discord OAuth gives no per-install token: the user's `bot`-scope
    // authorize INVITES the app's single bot into their guild, and we store the
    // returned guild id as the per-user credential. The broker injects the app's
    // BOT token as `accessToken` (from config), so `DISCORD_TOKEN` = that bot
    // token and `DISCORD_GUILD_ID` = the user's guild.
    enabled: true,
    auth: {
      kind: 'oauth_redirect',
      // `bot` invites the app's bot into the user's guild (Guild Install);
      // `guilds` lets the exchange read the guild name for display. The bot's
      // channel permissions (View Channels + Read Message History + Send
      // Messages + Send Messages in Threads) are set on the app's bot, NOT here.
      // ⚠️ The app's bot MUST have the Message Content privileged intent enabled
      // or read_messages returns empty content.
      scopes: ['bot', 'guilds'],
    },
    delivery: {
      mcp: {
        // mcp-discord (barryyip0625) — Node stdio, BYO bot token headless via the
        // DISCORD_TOKEN env (never argv). Version PINNED; bump only after
        // re-verifying headless. Tools: list/read channels + messages, send
        // message, reply in thread, add reaction. `DISCORD_GUILD_ID` scopes it to
        // the user's invited guild.
        command: 'npx',
        args: ['-y', 'mcp-discord@1.3.4'],
        envMapping: {
          DISCORD_TOKEN: 'accessToken',
          DISCORD_GUILD_ID: 'guildId',
        },
      },
    },
  },
  resend: {
    id: 'resend',
    name: 'Resend',
    icon: 'resend',
    category: 'comms',
    // LIVE — api_key (like Azure DevOps): the user pastes a Resend API key
    // (`re_…`); Resend has NO OAuth, so there's no OAuth app / GSM secret /
    // config-gated 503 — a backend VALIDATOR proves the key against the Resend
    // API and vaults it. ⚠️ SEND-ONLY email → `sendOnly: true` keeps it OUT of
    // From-Conversation (comms conversation sources need readable threads; Resend
    // has none) while still being a linkable comms tool the agent uses via MCP.
    enabled: true,
    sendOnly: true,
    auth: {
      kind: 'api_key',
      fields: [
        {
          key: 'accessToken',
          label: 'API Key',
          placeholder: 're_xxxxxxxxxxxxxxxx',
          secret: true,
          help: 'Create in Resend → API Keys (https://resend.com/api-keys). "Sending access" is enough.',
        },
      ],
    },
    delivery: {
      mcp: {
        // The OFFICIAL resend-mcp (Node) in BYO-token mode: the API key is fed
        // via RESEND_API_KEY (env only, never argv). Version PINNED; bump only
        // after re-verifying headless. Tools: send email + contacts/broadcasts/
        // domains.
        command: 'npx',
        args: ['-y', 'resend-mcp@2.6.1'],
        envMapping: {
          RESEND_API_KEY: 'accessToken',
        },
      },
    },
  },
  posthog: {
    id: 'posthog',
    name: 'PostHog',
    icon: 'posthog',
    category: 'observability',
    // LIVE — api_key: the user pastes a PostHog Personal API Key (phx_…, created
    // with the "MCP Server" preset). PostHog's MCP is HOSTED-ONLY
    // (mcp.posthog.com) over HTTP, and its stdio bridge (mcp-remote) forces its
    // own browser OAuth — incompatible with our headless broker. So delivery
    // uses the shim's HTTP transport: it relays to the hosted MCP with the key
    // as a Bearer header (exactly Cursor's {url, headers} config). No OAuth, no
    // GSM secret; a backend VALIDATOR proves the key + vaults it.
    enabled: true,
    auth: {
      kind: 'api_key',
      fields: [
        {
          key: 'accessToken',
          label: 'Personal API Key',
          placeholder: 'phx_xxxxxxxxxxxxxxxx',
          secret: true,
          help: 'PostHog → Settings → Personal API keys → create with the "MCP Server" preset (scopes it to a project).',
        },
      ],
    },
    delivery: {
      mcp: {
        // HTTP transport (not a spawned stdio server) — the shim relays to
        // PostHog's hosted MCP with the key as a Bearer header. The key stays
        // server-side of the shim, never on argv.
        command: '',
        args: [],
        envMapping: {},
        httpUrl: 'https://mcp.posthog.com/mcp',
        httpHeaders: { Authorization: 'Bearer {accessToken}' },
      },
    },
  },
  notion: {
    id: 'notion',
    name: 'Notion',
    icon: 'notion',
    category: 'docs',
    // LIVE — the Notion public OAuth integration is registered and
    // NOTION_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI are in Secret Manager
    // (prod+dev). The backend NotionOAuthProvider is config-gated (503 if env
    // unset) so this is safe even mid-rollout before the secrets mount.
    enabled: true,
    auth: {
      kind: 'oauth_redirect',
      // Notion does NOT use per-request OAuth scopes — access is governed by
      // the integration's configured CAPABILITIES (read/update/insert content
      // + read user info), set once on the Notion integration, not passed in
      // the authorize URL. So there is no `scope` param to request here.
      scopes: [],
    },
    delivery: {
      mcp: {
        // Notion's OFFICIAL stdio MCP server (Node). BYO-token headless: the
        // OAuth access token is fed via NOTION_TOKEN and the server sends it as
        // `Authorization: Bearer` + `Notion-Version: 2022-06-28` (env only,
        // never argv). No discriminator — the token alone authenticates its
        // workspace. Version PINNED; bump only after re-verifying headless.
        command: 'npx',
        args: ['-y', '@notionhq/notion-mcp-server@2.4.1'],
        envMapping: {
          NOTION_TOKEN: 'accessToken',
        },
      },
    },
  },
  azure_devops: {
    id: 'azure_devops',
    name: 'Azure DevOps',
    icon: 'azure_devops',
    category: 'tracker',
    // LIVE — the FIRST api_key (PAT) integration. No OAuth: Azure DevOps OAuth
    // apps are being sunset by Microsoft in favor of Entra ID, and PATs are the
    // native, reliable ADO auth. The user pastes their org URL + a PAT; the
    // backend validates against the ADO REST API and vaults it. No env secrets
    // to configure (config-gated 503 doesn't apply — there's no OAuth app).
    enabled: true,
    auth: {
      kind: 'api_key',
      fields: [
        {
          key: 'orgUrl',
          label: 'Organization URL',
          placeholder: 'https://dev.azure.com/your-org',
          secret: false,
          help: 'Your Azure DevOps organization URL — e.g. https://dev.azure.com/contoso',
        },
        {
          key: 'accessToken',
          label: 'Personal Access Token',
          placeholder: 'Paste your PAT',
          secret: true,
          help: 'Create in Azure DevOps → User settings → Personal access tokens. Recommended scopes: Work Items (Read & Write), Code (Read), Build (Read), Project and Team (Read).',
        },
      ],
    },
    delivery: {
      mcp: {
        // The @tiberriver256 ADO MCP server (Node) in PAT mode: the PAT is fed
        // via AZURE_DEVOPS_PAT (Basic auth) + the org via AZURE_DEVOPS_ORG_URL
        // (env only, never argv). AZURE_DEVOPS_AUTH_METHOD=pat pins the PAT path
        // (the alternative, azure-identity, uses DefaultAzureCredential and
        // would ignore our token). Version PINNED; bump only after re-verifying
        // headless.
        command: 'npx',
        args: ['-y', '@tiberriver256/mcp-server-azure-devops@0.1.46'],
        envMapping: {
          AZURE_DEVOPS_PAT: 'accessToken',
          AZURE_DEVOPS_ORG_URL: 'orgUrl',
        },
        staticEnv: { AZURE_DEVOPS_AUTH_METHOD: 'pat' },
      },
    },
  },
  figma: {
    id: 'figma',
    name: 'Figma',
    icon: 'figma',
    category: 'design',
    // DARK — pending Figma's OAuth-app review approval (submitted 2026-07-16).
    // Figma OAuth apps do NOT exist publicly until review passes (authorize URL
    // errors "OAuth app ... doesn't exist"). Backend provider + secrets are
    // already deployed; flip to true once approved (bead codeagent-m4ix).
    enabled: false,
    auth: {
      kind: 'oauth_redirect',
      // Granular READ-ONLY scopes (legacy `files:read` is deprecated for
      // OAuth). Asset export (GET /v1/images) rides file_content:read.
      // file_variables:read is Enterprise-only and would break linking for
      // normal accounts — deliberately excluded. ⚠️ Changing these requires
      // the user to RE-LINK Figma.
      scopes: [
        'current_user:read',
        'file_content:read',
        'file_metadata:read',
        'file_dev_resources:read',
        'library_content:read',
      ],
    },
    delivery: {
      mcp: {
        // Framelink figma-developer-mcp (Node, stdio) in BYO-token headless
        // mode — the ONLY known Figma MCP server that accepts an OAuth
        // Bearer token: FIGMA_OAUTH_TOKEN → `Authorization: Bearer` (env
        // only, never argv). Figma's official servers can't be used here
        // (remote = interactive OAuth + client allowlist; Dev Mode =
        // desktop app). Version PINNED; bump only after re-verifying
        // headless. Tools: get_figma_data (condensed layout extraction) +
        // download_figma_images (asset export).
        command: 'npx',
        args: ['-y', 'figma-developer-mcp@0.13.2', '--stdio', '--no-telemetry'],
        envMapping: {
          FIGMA_OAUTH_TOKEN: 'accessToken',
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

export function getIntegrationsByCategory(
  category: IntegrationCategory,
): IntegrationDefinition[] {
  return Object.values(INTEGRATION_REGISTRY).filter(
    (m) => m.category === category && m.enabled,
  );
}
