import { describe, it, expect } from 'vitest';
import type { IntegrationId, IntegrationDefinition } from '../src/integrations/types';
import {
  INTEGRATION_REGISTRY,
  getEnabledIntegrations,
  getIntegration,
  isKnownIntegrationId,
  getIntegrationsByCategory,
} from '../src/integrations/registry';
import {
  INTEGRATION_BRANDING,
  UPCOMING_INTEGRATION_IDS,
  getIntegrationBranding,
} from '../src/integrations/branding';
import { USER_EVENTS } from '../src/types/events';

describe('integrations registry', () => {
  it('declares jira (Atlassian) with the exact Jira + Confluence 3LO scopes', () => {
    const jira = getIntegration('jira');
    expect(jira.auth.kind).toBe('oauth_redirect');
    expect(jira.auth.scopes).toEqual([
      'read:jira-work',
      'write:jira-work',
      'read:confluence-content.all',
      'write:confluence-content',
      'offline_access',
    ]);
  });

  it('jira delivers via mcp with env-only credential mapping', () => {
    const jira = INTEGRATION_REGISTRY.jira;
    expect(jira.delivery.mcp).toBeDefined();
    expect(jira.delivery.mcp!.envMapping.ATLASSIAN_OAUTH_ACCESS_TOKEN).toBe('accessToken');
    expect(jira.delivery.mcp!.envMapping.ATLASSIAN_OAUTH_CLOUD_ID).toBe('cloudId');
    // credentials must NEVER ride argv
    expect(jira.delivery.mcp!.args.join(' ')).not.toMatch(/token|secret/i);
  });

  it('jira pins the exact mcp-atlassian version verified by the Docker int test', () => {
    const mcp = INTEGRATION_REGISTRY.jira.delivery.mcp!;
    expect(mcp.command).toBe('uvx');
    expect(mcp.args).toHaveLength(1);
    // Unpinned `mcp-atlassian` would drift under us between deploys; the pin
    // is bumped deliberately and re-verified by mcp-shim.int.test.ts.
    expect(mcp.args[0]).toMatch(/^mcp-atlassian==\d+\.\d+(\.\d+)?$/);
  });

  it('jira staticEnv enables BYO-token mode and carries no secret-looking material', () => {
    const mcp = INTEGRATION_REGISTRY.jira.delivery.mcp!;
    // Verified live (Task 9 Step 1): without ATLASSIAN_OAUTH_ENABLE=true the
    // server boots but silently registers ZERO Jira tools.
    expect(mcp.staticEnv?.ATLASSIAN_OAUTH_ENABLE).toBe('true');
    for (const [key, value] of Object.entries(mcp.staticEnv ?? {})) {
      // staticEnv is baked into manifests and logs — it must never hold secrets.
      expect(key).not.toMatch(/token|secret|password/i);
      expect(value).not.toMatch(/token|secret|password/i);
      expect(value.length).toBeLessThan(64); // real tokens are long opaque blobs
    }
  });

  it('every registry entry has id matching its key', () => {
    for (const [id, meta] of Object.entries(INTEGRATION_REGISTRY)) {
      expect((meta as IntegrationDefinition).id).toBe(id);
    }
  });

  it('helpers behave like the agents registry helpers', () => {
    expect(getEnabledIntegrations().map((m) => m.id)).toContain('jira');
    expect(isKnownIntegrationId('jira')).toBe(true);
    expect(isKnownIntegrationId('asana')).toBe(false);
    expect(() => getIntegration('nope' as IntegrationId)).toThrow(/Unknown integration/);
  });

  it('sentry is a live integration with read-first MVP scopes + BYO-token MCP delivery', () => {
    expect(isKnownIntegrationId('sentry')).toBe(true);
    const sentry = getIntegration('sentry');
    expect(sentry.name).toBe('Sentry');
    expect(sentry.auth.kind).toBe('oauth_redirect');
    // FULL read+write scopes across every resource (writes imply reads).
    expect(sentry.auth.scopes).toEqual([
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
    ]);
    // MCP delivery: BYO-token headless, creds via env only (never argv);
    // --add-scopes widens the server's default read-only tools to writes.
    expect(sentry.delivery.mcp?.command).toBe('npx');
    expect(sentry.delivery.mcp?.args).toContain(
      '--add-scopes=org:write,project:write,team:write,member:write,event:write',
    );
    expect(sentry.delivery.mcp?.envMapping).toEqual({
      SENTRY_ACCESS_TOKEN: 'accessToken',
      SENTRY_HOST: 'host',
    });
    // Live — surfaces in the enabled set alongside jira.
    expect(sentry.enabled).toBe(true);
    expect(getEnabledIntegrations().map((m) => m.id)).toContain('sentry');
  });

  it('linear is a live integration with read+write scopes + BYO-token stdio MCP delivery', () => {
    expect(isKnownIntegrationId('linear')).toBe(true);
    const linear = getIntegration('linear');
    expect(linear.name).toBe('Linear');
    expect(linear.icon).toBe('linear');
    expect(linear.auth.kind).toBe('oauth_redirect');
    // Coarse read + write scopes (write implies the create/update surface).
    expect(linear.auth.scopes).toEqual(['read', 'write']);
    // Headless stdio MCP: token via LINEAR_API_KEY (env, never argv). PINNED.
    expect(linear.delivery.mcp?.command).toBe('npx');
    expect(linear.delivery.mcp?.args).toEqual(['-y', 'mcp-linear@0.1.8']);
    expect(linear.delivery.mcp?.envMapping).toEqual({ LINEAR_API_KEY: 'accessToken' });
    // No extra credential discriminator — the token alone authenticates.
    expect(linear.delivery.mcp?.staticEnv).toBeUndefined();
    // Live — surfaces in the enabled set alongside jira + sentry.
    expect(linear.enabled).toBe(true);
    expect(getEnabledIntegrations().map((m) => m.id)).toContain('linear');
  });

  it('slack is a live integration with read+write bot scopes + BYO-token stdio MCP delivery', () => {
    expect(isKnownIntegrationId('slack')).toBe(true);
    const slack = getIntegration('slack');
    expect(slack.name).toBe('Slack');
    expect(slack.icon).toBe('slack');
    expect(slack.auth.kind).toBe('oauth_redirect');
    // Bot Token Scopes — read + write across channels/groups/DMs.
    expect(slack.auth.scopes).toEqual([
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
      'search:read',
    ]);
    // Official Slack MCP: bot token + team id via env (never argv). PINNED.
    expect(slack.delivery.mcp?.command).toBe('npx');
    expect(slack.delivery.mcp?.args).toEqual([
      '-y',
      '@modelcontextprotocol/server-slack@2025.4.25',
    ]);
    expect(slack.delivery.mcp?.envMapping).toEqual({
      SLACK_BOT_TOKEN: 'accessToken',
      SLACK_TEAM_ID: 'teamId',
    });
    expect(slack.enabled).toBe(true);
    expect(getEnabledIntegrations().map((m) => m.id)).toContain('slack');
  });

  it('notion is a live integration with NO oauth scopes + BYO-token stdio MCP delivery', () => {
    expect(isKnownIntegrationId('notion')).toBe(true);
    const notion = getIntegration('notion');
    expect(notion.name).toBe('Notion');
    expect(notion.icon).toBe('notion');
    expect(notion.auth.kind).toBe('oauth_redirect');
    // Notion has no per-request OAuth scopes (access = integration capabilities).
    expect(notion.auth.scopes).toEqual([]);
    // Official Notion MCP: token via NOTION_TOKEN (env, never argv). PINNED.
    expect(notion.delivery.mcp?.command).toBe('npx');
    expect(notion.delivery.mcp?.args).toEqual(['-y', '@notionhq/notion-mcp-server@2.4.1']);
    expect(notion.delivery.mcp?.envMapping).toEqual({ NOTION_TOKEN: 'accessToken' });
    expect(notion.delivery.mcp?.staticEnv).toBeUndefined();
    expect(notion.enabled).toBe(true);
    expect(getEnabledIntegrations().map((m) => m.id)).toContain('notion');
  });

  it('azure_devops is a live api_key (PAT) integration with orgUrl + accessToken fields', () => {
    expect(isKnownIntegrationId('azure_devops')).toBe(true);
    const ado = getIntegration('azure_devops');
    expect(ado.name).toBe('Azure DevOps');
    expect(ado.icon).toBe('azure_devops');
    // FIRST non-OAuth integration: api_key (the user pastes a PAT + org URL).
    expect(ado.auth.kind).toBe('api_key');
    expect(ado.auth.fields?.map((f) => f.key)).toEqual(['orgUrl', 'accessToken']);
    // The token field is masked; the org URL is not.
    expect(ado.auth.fields?.find((f) => f.key === 'accessToken')?.secret).toBe(true);
    expect(ado.auth.fields?.find((f) => f.key === 'orgUrl')?.secret).toBe(false);
    // Delivery: PAT mode, token + org via env (never argv). PINNED.
    expect(ado.delivery.mcp?.command).toBe('npx');
    expect(ado.delivery.mcp?.args).toEqual(['-y', '@tiberriver256/mcp-server-azure-devops@0.1.46']);
    expect(ado.delivery.mcp?.envMapping).toEqual({
      AZURE_DEVOPS_PAT: 'accessToken',
      AZURE_DEVOPS_ORG_URL: 'orgUrl',
    });
    expect(ado.delivery.mcp?.staticEnv).toEqual({ AZURE_DEVOPS_AUTH_METHOD: 'pat' });
    expect(ado.enabled).toBe(true);
    expect(getEnabledIntegrations().map((m) => m.id)).toContain('azure_devops');
  });

  it('resend is a live api_key SEND-ONLY comms integration (excluded from conversation sources)', () => {
    expect(isKnownIntegrationId('resend')).toBe(true);
    const resend = getIntegration('resend');
    expect(resend.name).toBe('Resend');
    expect(resend.icon).toBe('resend');
    expect(resend.category).toBe('comms');
    // api_key (like Azure DevOps): the user pastes a Resend API key, no OAuth.
    expect(resend.auth.kind).toBe('api_key');
    expect(resend.auth.fields?.map((f) => f.key)).toEqual(['accessToken']);
    expect(resend.auth.fields?.find((f) => f.key === 'accessToken')?.secret).toBe(true);
    // Official resend-mcp — key via RESEND_API_KEY (env, never argv). PINNED.
    expect(resend.delivery.mcp?.command).toBe('npx');
    expect(resend.delivery.mcp?.args).toEqual(['-y', 'resend-mcp@2.6.1']);
    expect(resend.delivery.mcp?.envMapping).toEqual({ RESEND_API_KEY: 'accessToken' });
    expect(resend.enabled).toBe(true);
    expect(getEnabledIntegrations().map((m) => m.id)).toContain('resend');
    // ⚠️ SEND-ONLY: a comms integration with no readable threads → excluded from
    // the From-Conversation source set (comms MINUS sendOnly), but Slack/Discord
    // (conversational) stay in.
    expect(resend.sendOnly).toBe(true);
    const conversationSources = getIntegrationsByCategory('comms')
      .filter((m) => !m.sendOnly)
      .map((m) => m.id);
    expect(conversationSources).not.toContain('resend');
    expect(conversationSources).toContain('slack');
    expect(conversationSources).toContain('discord');
  });

  it('figma is a dark integration (pending OAuth-app review) with read-only granular scopes + BYO-token MCP delivery', () => {
    // Figma — DARK pending Figma's OAuth-app review approval. Read-only granular
    // scopes (design-to-code + asset export); the api-v2 FigmaOAuthProvider is
    // config-gated (503 if env unset).
    expect(isKnownIntegrationId('figma')).toBe(true);
    expect(INTEGRATION_REGISTRY.figma.enabled).toBe(false);
    expect(INTEGRATION_REGISTRY.figma.auth.kind).toBe('oauth_redirect');
    expect(INTEGRATION_REGISTRY.figma.auth.scopes).toEqual([
      'current_user:read',
      'file_content:read',
      'file_metadata:read',
      'file_dev_resources:read',
      'library_content:read',
    ]);
    expect(INTEGRATION_REGISTRY.figma.delivery.mcp?.command).toBe('npx');
    expect(INTEGRATION_REGISTRY.figma.delivery.mcp?.args).toEqual([
      '-y',
      'figma-developer-mcp@0.13.2',
      '--stdio',
      '--no-telemetry',
    ]);
    expect(INTEGRATION_REGISTRY.figma.delivery.mcp?.envMapping).toEqual({
      FIGMA_OAUTH_TOKEN: 'accessToken',
    });
  });

  it('discord is a LIVE comms integration (OAuth bot-invite, guildId discriminator, mcp-discord delivery)', () => {
    // Discord — LIVE. Follows the Slack pattern (OAuth redirect) EXCEPT there's
    // no per-install token: `accessToken` = the app's bot token (broker-injected
    // from config) and the per-user credential is the invited guild id. The
    // backend DiscordOAuthProvider is config-gated (503 if env unset).
    expect(isKnownIntegrationId('discord')).toBe(true);
    const discord = getIntegration('discord');
    expect(discord.name).toBe('Discord');
    expect(discord.icon).toBe('discord');
    expect(discord.category).toBe('comms');
    expect(discord.enabled).toBe(true);
    expect(discord.auth.kind).toBe('oauth_redirect');
    // `bot` invites the app's bot into the guild; `guilds` reads the guild name.
    expect(discord.auth.scopes).toEqual(['bot', 'guilds']);
    // mcp-discord (Node stdio) — bot token via DISCORD_TOKEN, guild scope via
    // DISCORD_GUILD_ID (env, never argv). PINNED.
    expect(discord.delivery.mcp?.command).toBe('npx');
    expect(discord.delivery.mcp?.args).toEqual(['-y', 'mcp-discord@1.3.4']);
    expect(discord.delivery.mcp?.envMapping).toEqual({
      DISCORD_TOKEN: 'accessToken',
      DISCORD_GUILD_ID: 'guildId',
    });
    expect(getEnabledIntegrations().map((m) => m.id)).toContain('discord');
  });

  it('gitlab is a live oauth_redirect integration in version_control with api + write_repository', () => {
    expect(isKnownIntegrationId('gitlab')).toBe(true);
    const gl = getIntegration('gitlab');
    expect(gl.name).toBe('GitLab');
    expect(gl.category).toBe('version_control');
    expect(gl.enabled).toBe(true);
    // A NORMAL vaulted OAuth integration — NOT connection-backed like github,
    // because nothing else in the product owns a GitLab connection.
    expect(gl.auth.kind).toBe('oauth_redirect');
    expect(gl.auth.connection).toBeUndefined();
    expect(gl.auth.derivedFrom).toBeUndefined();
    // `api` is the only GitLab scope granting MR write; `write_repository` is
    // the git-over-HTTPS rail. ⚠️ Changing these forces every user to re-auth.
    expect(gl.auth.scopes).toEqual(['api', 'write_repository']);
    // No MCP — the MR surface is backend-side, same as github.
    expect(gl.delivery).toEqual({});
  });

  it('github is a live CONNECTION integration in version_control — owns its actions', () => {
    // GitHub is the code substrate, and was historically the ONE connection
    // outside the registry (hand-written row, illegal in `integrationIds`).
    expect(isKnownIntegrationId('github')).toBe(true);
    const gh = getIntegration('github');
    expect(gh.name).toBe('GitHub');
    expect(gh.category).toBe('version_control');
    expect(gh.enabled).toBe(true);
    expect(getEnabledIntegrations().map((m) => m.id)).toContain('github');

    // `connection` — NOT `derived`. It IS the source, so unlike github_issues
    // it keeps a real connect/disconnect (performed by the codespaces rail).
    expect(gh.auth.kind).toBe('connection');
    expect(gh.auth.connection).toBe('github');
    expect(gh.auth.derivedFrom).toBeUndefined();
    expect(gh.delivery).toEqual({});
  });

  it('github_issues is a live DERIVED tracker — no link flow, no MCP delivery', () => {
    // The only integration whose credential is borrowed from another
    // connection (the codespaces GitHub OAuth token) instead of being linked
    // and vaulted in its own right.
    expect(isKnownIntegrationId('github_issues')).toBe(true);
    const gh = getIntegration('github_issues');
    expect(gh.name).toBe('GitHub Issues');
    expect(gh.icon).toBe('github_issues');
    expect(gh.category).toBe('tracker');
    expect(gh.enabled).toBe(true);
    expect(getEnabledIntegrations().map((m) => m.id)).toContain('github_issues');

    // Derived auth: no OAuth app, so no scopes and no pasted api_key fields —
    // the source connection is the whole credential story.
    expect(gh.auth.kind).toBe('derived');
    expect(gh.auth.derivedFrom).toBe('github');
    expect(gh.auth.scopes).toBeUndefined();
    expect(gh.auth.fields).toBeUndefined();

    // Empty delivery is DELIBERATE (a deployed box already has an
    // authenticated `gh`), so there is nothing to pre-warm. Guarding it here
    // means adding an MCP server later has to be a conscious edit.
    expect(gh.delivery).toEqual({});
    expect(gh.delivery.mcp).toBeUndefined();
    expect(gh.delivery.cliEnv).toBeUndefined();
  });

  it('declares the three integration USER_EVENTS names', () => {
    expect(USER_EVENTS.INTEGRATION_LINKED).toBe('integration_linked');
    expect(USER_EVENTS.INTEGRATION_UNLINKED).toBe('integration_unlinked');
    expect(USER_EVENTS.INTEGRATION_CREDENTIAL_INVALID).toBe('integration_credential_invalid');
  });

  it('every integration declares its category (Start-from-Work-Item groups by it)', () => {
    const expected: Record<string, string> = {
      github: 'version_control',
      gitlab: 'version_control',
      jira: 'tracker',
      linear: 'tracker',
      azure_devops: 'tracker',
      github_issues: 'tracker',
      sentry: 'observability',
      slack: 'comms',
      microsoft_teams: 'comms',
      google_chat: 'comms',
      discord: 'comms',
      resend: 'comms',
      notion: 'docs',
      figma: 'design',
    };
    for (const [id, meta] of Object.entries(INTEGRATION_REGISTRY)) {
      expect(meta.category).toBe(expected[id]);
    }
    // Helper returns ONLY enabled integrations of the category (figma is dark).
    expect(getIntegrationsByCategory('tracker').map((m) => m.id).sort()).toEqual([
      'azure_devops',
      'github_issues',
      'jira',
      'linear',
    ]);
    expect(getIntegrationsByCategory('design').map((m) => m.id)).toEqual([]);
    expect(getIntegrationsByCategory('version_control').map((m) => m.id).sort()).toEqual([
      'github',
      'gitlab',
    ]);
  });
});

describe('integration branding catalog', () => {
  const HEX_COLOR_RE = /^#[0-9A-Fa-f]{3,8}$/;

  it('every branding entry has a non-empty logoSvg starting with <svg', () => {
    for (const [id, branding] of Object.entries(INTEGRATION_BRANDING)) {
      expect(branding.logoSvg.length).toBeGreaterThan(0);
      expect(branding.logoSvg.trim().startsWith('<svg')).toBe(true);
      expect(branding.id).toBe(id);
    }
  });

  it('every branding entry has a valid brandColor hex value', () => {
    for (const branding of Object.values(INTEGRATION_BRANDING)) {
      expect(branding.brandColor).toMatch(HEX_COLOR_RE);
    }
  });

  it('the jira registry id is present in the branding catalog', () => {
    expect(INTEGRATION_BRANDING.jira).toBeDefined();
    expect(INTEGRATION_BRANDING.jira.name).toBe('Atlassian');
  });

  it('every upcoming integration id has a branding entry', () => {
    for (const id of UPCOMING_INTEGRATION_IDS) {
      expect(getIntegrationBranding(id)).not.toBeNull();
    }
  });

  it('the COMING SOON set is the expected 16 tools (none already live)', () => {
    expect([...UPCOMING_INTEGRATION_IDS]).toEqual([
      'gmail',
      'posthog',
      'clickup',
      'figma',
      'trello',
      'vercel',
      'supabase',
      'asana',
      'postman',
      'n8n',
      'stripe',
      'mixpanel',
      'pendo',
      'pagerduty',
      'amplitude',
      'datadog',
    ]);
    // An upcoming id must NOT collide with a live registry id (that would
    // render it both as AVAILABLE and COMING SOON).
    const liveIds = new Set<string>(getEnabledIntegrations().map((m) => m.id));
    for (const id of UPCOMING_INTEGRATION_IDS) expect(liveIds.has(id)).toBe(false);
  });

  it('getIntegrationBranding returns null for an unknown id', () => {
    expect(getIntegrationBranding('nope')).toBeNull();
  });

  it('logoSvg strings hold no secret-looking material and no external fetch targets', () => {
    for (const branding of Object.values(INTEGRATION_BRANDING)) {
      expect(branding.logoSvg).not.toMatch(/token|secret/i);
      // xmlns declarations are fine (they're not fetched); href/src fetch targets are not.
      expect(branding.logoSvg).not.toMatch(/\bhref=/i);
      expect(branding.logoSvg).not.toMatch(/\bsrc=/i);
      const httpMatches = branding.logoSvg.match(/https?:\/\/\S+/gi) ?? [];
      for (const match of httpMatches) {
        // Only allow the xmlns URI itself, never a live fetch target.
        expect(match.replace(/["'>].*$/, '')).toBe('http://www.w3.org/2000/svg');
      }
    }
  });
});
