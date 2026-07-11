import { describe, it, expect } from 'vitest';
import type { IntegrationId, IntegrationDefinition } from '../src/integrations/types';
import {
  INTEGRATION_REGISTRY,
  getEnabledIntegrations,
  getIntegration,
  isKnownIntegrationId,
} from '../src/integrations/registry';
import { USER_EVENTS } from '../src/types/events';

describe('integrations registry', () => {
  it('declares jira with the exact 3LO scopes', () => {
    const jira = getIntegration('jira');
    expect(jira.auth.kind).toBe('oauth_redirect');
    expect(jira.auth.scopes).toEqual(['read:jira-work', 'write:jira-work', 'offline_access']);
  });

  it('jira delivers via mcp with env-only credential mapping', () => {
    const jira = INTEGRATION_REGISTRY.jira;
    expect(jira.delivery.mcp).toBeDefined();
    expect(jira.delivery.mcp!.envMapping.ATLASSIAN_OAUTH_ACCESS_TOKEN).toBe('accessToken');
    expect(jira.delivery.mcp!.envMapping.ATLASSIAN_OAUTH_CLOUD_ID).toBe('cloudId');
    // credentials must NEVER ride argv
    expect(jira.delivery.mcp!.args.join(' ')).not.toMatch(/token|secret/i);
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
