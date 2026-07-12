import { describe, it, expect } from 'vitest';
import type { IntegrationId, IntegrationDefinition } from '../src/integrations/types';
import {
  INTEGRATION_REGISTRY,
  getEnabledIntegrations,
  getIntegration,
  isKnownIntegrationId,
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
    expect(isKnownIntegrationId('slack')).toBe(false);
    expect(() => getIntegration('nope' as IntegrationId)).toThrow(/Unknown integration/);
  });

  it('declares the three integration USER_EVENTS names', () => {
    expect(USER_EVENTS.INTEGRATION_LINKED).toBe('integration_linked');
    expect(USER_EVENTS.INTEGRATION_UNLINKED).toBe('integration_unlinked');
    expect(USER_EVENTS.INTEGRATION_CREDENTIAL_INVALID).toBe('integration_credential_invalid');
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
