/**
 * Agent Toolkits — integration wire types.
 * Spec: docs/superpowers/specs/2026-07-10-agent-toolkits-integrations-design.md
 *
 * Decision rule for the delivery rails: if the agent already masters a
 * ubiquitous CLI for the tool → `cliEnv`; otherwise → `mcp`. A tool may
 * declare both.
 */
export type IntegrationId =
  | 'jira'
  | 'sentry'
  | 'linear'
  | 'slack'
  | 'notion'
  | 'azure_devops'
  | 'figma'
  | 'microsoft_teams'
  | 'google_chat'
  | 'discord'
  | 'resend'
  | 'posthog'
  | 'datadog'
  | 'stitch'
  | 'github_issues'
  | 'github'
  | 'gitlab'
  | 'vercel'
  | 'trello'
  | 'clickup'
  | 'n8n'
  | 'postman'
  | 'mixpanel'
  | 'supabase'
  | 'confluence'
  | 'cloudflare';

/**
 * `derived` = no link flow of its own: the credential is BORROWED live from a
 * connection the user already made elsewhere (see `derivedFrom`). The backend
 * resolves it per call instead of vaulting a copy, so it can never go stale and
 * there is exactly one source of truth. Such an integration is "linked" iff its
 * source connection exists, and has no Connect/Disconnect action of its own.
 */
/**
 * `connection` = the integration IS a standing connection whose credential lives
 * in a `ProviderToken` row rather than the integrations vault, and whose
 * connect/disconnect flow is owned by ANOTHER module (GitHub's OAuth belongs to
 * the codespaces rail). It renders and acts like any other connector — the only
 * difference is which code performs the link.
 *
 * Contrast `derived`, which BORROWS such a connection and owns no actions at
 * all. Both resolve their credential from the same place; only `derived` has no
 * link flow of its own.
 */
export type IntegrationAuthKind =
  | 'oauth_redirect'
  | 'oauth_device'
  | 'api_key'
  | 'derived'
  | 'connection';

/**
 * A standing connection whose credential lives in a `ProviderToken` row — either
 * because the integration IS that connection (`kind: 'connection'`) or because
 * it borrows it (`kind: 'derived'`). Its own id doubles as the source name.
 */
export type DerivedCredentialSource = 'github';

/** Grouping used by category-driven surfaces (Start-from-Work-Item picker,
 *  catalog sections). A future tracker integration joins those features with
 *  ZERO feature code — they resolve sources from the registry by category. */
export type IntegrationCategory =
  | 'version_control'
  | 'tracker'
  | 'design'
  | 'comms'
  | 'docs'
  | 'observability'
  | 'deployment'
  | 'automation'
  | 'analytics'
  | 'api_tools'
  | 'database';

/**
 * One user-entered field for an `api_key` integration (no browser OAuth — the
 * user pastes credentials directly, e.g. a PAT + an org URL). The mobile form
 * is driven entirely by this list, and `key` maps to a `BrokeredIntegrationToken`
 * field the delivery `envMapping` references.
 */
export interface IntegrationApiKeyField {
  /** Maps to a BrokeredIntegrationToken field (`accessToken`, `orgUrl`,
   *  `appKey`, `host`, …). */
  key: 'accessToken' | 'orgUrl' | 'appKey' | 'host' | 'apiKey' | 'instanceUrl' | 'secretKey' | 'projectId';
  /** Form label. */
  label: string;
  /** Example / placeholder. */
  placeholder?: string;
  /** Masked (secret) input — true for the token, false for a plain URL. */
  secret?: boolean;
  /** Short help under the field (e.g. how to create the PAT). */
  help?: string;
}

export type IntegrationHealth = 'ok' | 'expired' | 'revoked';

/** stdio MCP server spec, executed as DATA by the CLI shim (`codeam mcp-run <id>`).
 *
 * Two transports:
 *  - **stdio (default):** the shim spawns `command args` (with `envMapping`
 *    credentials in the env) and byte-pipes it to the agent.
 *  - **HTTP (`httpUrl` set):** the shim connects to a REMOTE MCP over
 *    Streamable HTTP and relays it to the agent's stdio — for vendors that only
 *    ship a hosted MCP (e.g. PostHog `mcp.posthog.com`). `command`/`args` are
 *    unused (empty); credentials go in `httpHeaders` (never `envMapping`).
 */
export interface IntegrationMcpDelivery {
  command: string;
  args: string[];
  /** env var name → credential field (`accessToken` | `cloudId` | …). Env only, never argv. STDIO transport. */
  envMapping: Record<string, string>;
  /** Static, non-credential env the server needs to boot (e.g. mode flags).
   *  Merged into the child env BENEATH the credential envMapping. Never secrets. STDIO transport. */
  staticEnv?: Record<string, string>;
  /** HTTP transport — a REMOTE MCP URL (Streamable HTTP). When set, the shim
   *  relays to it instead of spawning `command`. May carry `{field}` placeholders
   *  filled from the BrokeredIntegrationToken (e.g. a per-user regional host:
   *  `https://mcp.{host}/…`). */
  httpUrl?: string;
  /** HTTP transport — header name → value TEMPLATE with `{field}` placeholders
   *  filled from the BrokeredIntegrationToken at spawn (e.g.
   *  `{ Authorization: 'Bearer {accessToken}' }` or Datadog's
   *  `{ 'DD-API-KEY': '{accessToken}', 'DD-APPLICATION-KEY': '{appKey}' }`). The
   *  token stays server-side of the shim — never on argv. */
  httpHeaders?: Record<string, string>;
}

export interface IntegrationDelivery {
  mcp?: IntegrationMcpDelivery;
  /** env var name → credential field, merged into agent child spawns. No MVP consumer. */
  cliEnv?: Record<string, string>;
}

export interface IntegrationDefinition {
  id: IntegrationId;
  name: string;
  icon: string;
  category: IntegrationCategory;
  enabled: boolean;
  /** A `comms` integration that only SENDS (e.g. Resend email) — it has no
   *  readable threads, so it is EXCLUDED from From-Conversation's source list
   *  (which needs `listRecentThreads`/`getThread`/`postReply`) while still being
   *  a linkable comms tool the agent uses via its MCP delivery. Absent/false for
   *  conversational comms (Slack, Discord). */
  sendOnly?: boolean;
  auth: {
    kind: IntegrationAuthKind;
    scopes?: string[];
    /** For `kind: 'api_key'` — the credential fields the user pastes (no OAuth). */
    fields?: IntegrationApiKeyField[];
    /** For `kind: 'derived'` — the connection whose credential this borrows.
     *  Drives both the backend's credential resolution and the client's
     *  "no connect action, managed by <source>" rendering. */
    derivedFrom?: DerivedCredentialSource;
    /** For `kind: 'connection'` — the connection this integration IS. Same
     *  credential lookup as `derivedFrom`, but this one owns its link flow
     *  (performed by the module that owns the connection, not by the generic
     *  integrations OAuth path). */
    connection?: DerivedCredentialSource;
    /** For `kind: 'derived'` — the OTHER integration whose vaulted credential
     *  this one reuses (Confluence → `jira`, since one Atlassian OAuth + the one
     *  `mcp-atlassian` server serves both). Like `derivedFrom` but the source is
     *  a vault-backed integration, not a `ProviderToken` connection: the backend
     *  resolves the credential by delegating to the source integration, and the
     *  client renders it as "part of <source>" with no Connect action of its own. */
    aliasOf?: IntegrationId;
    /** SECONDARY api-key / PAT path for a PRIMARY OAuth integration. OAuth
     *  (`kind`) stays the primary/preferred flow; this lets the user paste a
     *  personal access token instead — a fallback while the vendor's OAuth app
     *  is in review, or a permanent alternative (like GitHub OAuth + PAT).
     *  ⚠️ The PAT often needs a DIFFERENT delivery env var than the OAuth token
     *  (e.g. Figma: OAuth → `FIGMA_OAUTH_TOKEN`/Bearer, PAT →
     *  `FIGMA_API_KEY`/`X-Figma-Token`), so it carries its OWN `envMapping` used
     *  INSTEAD of `delivery.mcp.envMapping` when the credential was linked via PAT. */
    apiKeyFallback?: {
      fields: IntegrationApiKeyField[];
      envMapping: Record<string, string>;
    };
  };
  delivery: IntegrationDelivery;
}

/** What a deploy writes to `~/.codeam/integrations.json` — manifests, never secrets. */
export interface IntegrationsManifestEntry {
  id: IntegrationId;
  delivery: IntegrationDelivery;
}
export interface IntegrationsManifest {
  integrations: IntegrationsManifestEntry[];
}

/** `GET /api/integrations` row: registry definition merged with the user's link state. */
export interface IntegrationStatus {
  id: IntegrationId;
  linked: boolean;
  health?: IntegrationHealth;
  siteUrl?: string;
  accountEmail?: string;
  linkedAt?: string;
}

/** `POST /api/plugin/integrations/:id/token` response — ~1 h access token, never a refresh token. */
export interface BrokeredIntegrationToken {
  accessToken: string;
  expiresAt: string;
  /** Atlassian cloud id — the site the Jira MCP server targets. */
  cloudId?: string;
  /** Sentry host (e.g. `sentry.io`, or a self-hosted domain) — the API base
   *  the Sentry MCP server targets. Absent for integrations that don't need
   *  a host discriminator. */
  host?: string;
  /** Slack workspace/team id (`T…`) — the Slack MCP server needs it alongside
   *  the bot token (`SLACK_TEAM_ID`). Absent for non-Slack integrations. */
  teamId?: string;
  /** Azure DevOps organization URL (`https://dev.azure.com/<org>`) — the ADO
   *  MCP server needs it alongside the PAT (`AZURE_DEVOPS_ORG_URL`). Absent for
   *  non-ADO integrations. */
  orgUrl?: string;
  /** Discord guild (server) id the app's bot was invited into for this user —
   *  the `mcp-discord` server scopes to it (`DISCORD_GUILD_ID`). ⚠️ Discord OAuth
   *  gives NO per-install token (unlike Slack): `accessToken` here is the app's
   *  single BOT token, injected by the broker from config — the per-user
   *  credential IS the guildId. Absent for non-Discord integrations. */
  guildId?: string;
  /** Datadog Application key (user-scoped) — sent alongside the API key
   *  (`accessToken`) as the `DD-APPLICATION-KEY` header; `host` carries the
   *  regional site. Absent for non-Datadog integrations. */
  appKey?: string;
  /** Trello developer API key — the app-level key the Trello MCP server needs
   *  alongside the user token (`TRELLO_API_KEY` + `TRELLO_TOKEN`=`accessToken`).
   *  Absent for non-Trello integrations. */
  apiKey?: string;
  /** n8n instance base URL (self-hosted or n8n.cloud) — the MCP server needs it
   *  alongside the API key (N8N_API_URL + N8N_API_KEY). Absent for non-n8n. */
  instanceUrl?: string;
  /** Secret half of a 2-part api_key credential (Amplitude secret, Mixpanel
   *  service-account password, etc.). Absent for single-key integrations. */
  secretKey?: string;
  /** Project/workspace id some analytics APIs require (Mixpanel project id). */
  projectId?: string;
  /** Cloudflare account id — the Cloudflare MCP needs it alongside the OAuth
   *  access token (`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`) for
   *  account-level operations. Captured at link time from `GET /accounts`.
   *  Absent for non-Cloudflare integrations. */
  accountId?: string;
}
