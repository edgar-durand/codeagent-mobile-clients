/**
 * Agent Toolkits — integration wire types.
 * Spec: docs/superpowers/specs/2026-07-10-agent-toolkits-integrations-design.md
 *
 * Decision rule for the delivery rails: if the agent already masters a
 * ubiquitous CLI for the tool → `cliEnv`; otherwise → `mcp`. A tool may
 * declare both.
 */
export type IntegrationId = 'jira' | 'sentry';

export type IntegrationAuthKind = 'oauth_redirect' | 'oauth_device' | 'api_key';

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
  enabled: boolean;
  auth: { kind: IntegrationAuthKind; scopes?: string[] };
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
}
