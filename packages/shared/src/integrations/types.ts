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
  | 'discord';

export type IntegrationAuthKind = 'oauth_redirect' | 'oauth_device' | 'api_key';

/** Grouping used by category-driven surfaces (Start-from-Work-Item picker,
 *  catalog sections). A future tracker integration joins those features with
 *  ZERO feature code — they resolve sources from the registry by category. */
export type IntegrationCategory =
  | 'tracker'
  | 'design'
  | 'comms'
  | 'docs'
  | 'observability';

/**
 * One user-entered field for an `api_key` integration (no browser OAuth — the
 * user pastes credentials directly, e.g. a PAT + an org URL). The mobile form
 * is driven entirely by this list, and `key` maps to a `BrokeredIntegrationToken`
 * field the delivery `envMapping` references.
 */
export interface IntegrationApiKeyField {
  /** Maps to a BrokeredIntegrationToken field (`accessToken`, `orgUrl`, …). */
  key: 'accessToken' | 'orgUrl';
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

/** stdio MCP server spec, executed as DATA by the CLI shim (`codeam mcp-run <id>`). */
export interface IntegrationMcpDelivery {
  command: string;
  args: string[];
  /** env var name → credential field (`accessToken` | `cloudId` | …). Env only, never argv. */
  envMapping: Record<string, string>;
  /** Static, non-credential env the server needs to boot (e.g. mode flags).
   *  Merged into the child env BENEATH the credential envMapping. Never secrets. */
  staticEnv?: Record<string, string>;
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
  auth: {
    kind: IntegrationAuthKind;
    scopes?: string[];
    /** For `kind: 'api_key'` — the credential fields the user pastes (no OAuth). */
    fields?: IntegrationApiKeyField[];
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
}
